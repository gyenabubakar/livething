// Tree-shaking guard for the published `@livething/*` packages (server spec §24).
//
// Each package ships lightweight subpath entries alongside its main one, and
// promises that importing a light subpath does NOT drag heavy runtime code in.
// This script proves that empirically against the BUILT `dist`: it bundles each
// public entry with esbuild and inspects the emitted code for per-engine
// markers.
//
// A marker is a string literal that uniquely identifies one engine's code and
// survives vite's `minify: true`. SQL table/index names and wire-frame tags are
// ideal — they are string data, not identifiers, so minification leaves them
// intact. We never key on a local/function name (those get mangled).
//
// Each suite pins an exact matrix: for every entry we assert its OWN engine (and
// only its documented runtime dependencies) are present, and every OTHER engine
// is absent. A new accidental import that drags an engine into the wrong bundle
// makes a forbidden marker appear — and the check fails.
//
// Three suites run:
//   • @livething/server — one bundle entry per feature; the split is fine-grained.
//   • @livething/client — one socket runtime plus a few light utility subpaths; the
//     guarantee is that those utilities never pull the connection runtime.
//   • @livething/server-node — the public Node adapter entry; the check makes sure
//     its runtime is present and no Cloudflare runtime is bundled into it.

import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

// ---------------------------------------------------------------------------
// @livething/server — every feature is its own bundle entry.
//
// Not every capability has a detectable engine here. `intercept` is deliberately
// absent: the intercept primitive is core infrastructure (server, channels,
// requests and rate-limit all use it internally), so it is present in every
// server and is not a tree-shakeable per-feature engine. Plain (ephemeral)
// streams likewise carry no durable marker — there is nothing to persist.
//
// Channel membership is durable by default, and `channels()` creates and owns
// its table unconditionally, so `channel` and `channelStorage` are split
// apart — `channel` is the wire runtime, present wherever a channel is
// targeted (for example channel-scoped requests or replay); `channelStorage`
// is the membership table, owned only by `channels()` itself.
// ---------------------------------------------------------------------------
const SERVER_DIST = resolve(repoRoot, 'server/dist');

const SERVER_ENGINES = {
  streamDurable: {
    marker: '__livething_stream_chunks',
    label: 'durable-stream engine (recorded chunk store)',
  },
  channel: { marker: '__subscribeOk__', label: 'channel runtime' },
  channelStorage: {
    marker: '__livething_channel_memberships',
    label: 'channel membership storage engine',
  },
  scheduled: { marker: '__livething_scheduled', label: 'scheduled-task engine' },
  sequence: { marker: '__livething_sequence', label: 'sequence engine' },
  tags: { marker: '__livething_tags', label: 'tags storage engine' },
  replay: { marker: '__livething_replay', label: 'replay engine' },
  inbox: { marker: '__livething_inbox', label: 'inbox engine' },
  lastSeen: { marker: '__livething_last_seen', label: 'last-seen engine' },
  keepalive: { marker: '__livething: "keepalive"', label: 'keepalive capability' },
  dedup: { marker: '__livething: "dedup"', label: 'dedup capability' },
  request: { marker: '__livething: "request"', label: 'request engine' },
  serverRequest: { marker: 'request-not-declared', label: 'server-request engine' },
  rateLimit: { marker: ' at scope ', label: 'rate-limit engine' },
  // `plugins.ts` is a bundle entry, so a bundler keeps the module whole: one
  // value import of anything it exports drags the wire-namespacing pass and the
  // plugin-scoped context in with it. This marker is the canary for that edge.
  plugin: { marker: '__livething: "pluginSurface"', label: 'plugin runtime' },
};

function serverScenarios(f) {
  return [
    {
      name: 'minimal server (server + emits)',
      source: importNamed(f('index.js'), 'server', 'emits'),
      owns: null,
      alsoPulls: [],
    },
    { name: 'errors', source: importStar(f('errors.js')), owns: null, alsoPulls: [] },
    {
      name: 'client requests only',
      source: importStar(f('client-requests.js')),
      owns: 'request',
      alsoPulls: ['channel'],
    },
    {
      name: 'server requests only',
      source: importStar(f('server-requests.js')),
      owns: 'serverRequest',
      alsoPulls: [],
    },
    { name: 'scheduled', source: importStar(f('scheduled.js')), owns: 'scheduled', alsoPulls: [] },
    { name: 'dedup', source: importStar(f('dedup.js')), owns: 'dedup', alsoPulls: [] },
    { name: 'sequence', source: importStar(f('sequence.js')), owns: 'sequence', alsoPulls: [] },
    { name: 'keepalive', source: importStar(f('keepalive.js')), owns: 'keepalive', alsoPulls: [] },
    {
      name: 'rate-limit',
      source: importStar(f('rate-limit.js')),
      owns: 'rateLimit',
      alsoPulls: [],
    },
    // Replay can be channel-scoped, so it pulls the channel runtime.
    { name: 'replay', source: importStar(f('replay.js')), owns: 'replay', alsoPulls: ['channel'] },
    // Durable streams schedule background sweeps to retire their stored state, so
    // the streams barrel pulls the scheduled-task engine. `streamDurable` covers
    // the recorded (chunk-storing) variant; that marker is the durable proof.
    {
      name: 'streams (all kinds)',
      source: importStar(f('streams.js')),
      owns: 'streamDurable',
      alsoPulls: ['scheduled'],
    },
    // Picking only the plain, ephemeral `stream` from the same barrel must tree-
    // shake BOTH durable variants and the scheduled sweep away.
    {
      name: 'stream (plain) only',
      source: importNamed(f('streams.js'), 'stream'),
      owns: null,
      alsoPulls: [],
    },
    // `channels()` owns both the wire runtime and the membership table it
    // creates and manages — a channel is durable by default, and
    // `persistent: false` opts a channel out per channel.
    {
      name: 'channels',
      source: importStar(f('channels.js')),
      owns: ['channel', 'channelStorage'],
      alsoPulls: [],
    },
    { name: 'tags', source: importStar(f('tags.js')), owns: 'tags', alsoPulls: [] },
    // Inbox reads channel membership to resolve who a channel's messages go to,
    // so it pulls in the membership table's SQL (channelStorage), not the wire
    // runtime — inbox is a channel-only capability, so `channels()` is always
    // listed alongside it anyway.
    {
      name: 'inbox',
      source: importStar(f('inbox.js')),
      owns: 'inbox',
      alsoPulls: ['channelStorage'],
    },
    {
      name: 'last-seen',
      source: importStar(f('last-seen.js')),
      owns: 'lastSeen',
      alsoPulls: [],
    },
    { name: 'intercepts', source: importStar(f('intercepts.js')), owns: null, alsoPulls: [] },
    { name: 'plugins', source: importStar(f('plugins.js')), owns: 'plugin', alsoPulls: [] },
  ];
}

// ---------------------------------------------------------------------------
// @livething/client — one connection runtime plus light utility subpaths.
//
// There is no per-feature split on the client: the socket owns every wire
// behavior. The single guarantee worth pinning is that the utility subpaths
// (`errors`, `environment`, `platform`) and the test-helper entry (`testing`)
// never pull the connection runtime — importing `@livething/client/errors` must not
// ship a WebSocket engine.
// ---------------------------------------------------------------------------
const CLIENT_DIST = resolve(repoRoot, 'client/dist');

const CLIENT_ENGINES = {
  socket: { marker: '__subscribeOk__', label: 'socket connection runtime' },
};

function clientScenarios(f) {
  return [
    {
      name: 'index (full socket)',
      source: importStar(f('index.js')),
      owns: 'socket',
      alsoPulls: [],
    },
    { name: 'errors', source: importStar(f('errors.js')), owns: null, alsoPulls: [] },
    { name: 'environment', source: importStar(f('environment.js')), owns: null, alsoPulls: [] },
    { name: 'platform', source: importStar(f('platform.js')), owns: null, alsoPulls: [] },
    { name: 'testing', source: importStar(f('testing.js')), owns: null, alsoPulls: [] },
  ];
}

const NODE_ADAPTER_DIST = resolve(repoRoot, 'server-adapters/node/dist');
const NODE_ADAPTER_MARKER = '[livething] Node binding is shutting down';

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
function importStar(path) {
  return `import * as m from ${JSON.stringify(path)};\nexport { m };`;
}

function importNamed(path, ...names) {
  return `import { ${names.join(', ')} } from ${JSON.stringify(path)};\nexport { ${names.join(', ')} };`;
}

async function bundle(source, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'livething-bundle-check-'));
  const entry = join(dir, 'entry.mjs');
  await writeFile(entry, source);
  try {
    const result = await build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      format: 'esm',
      platform: options.platform ?? 'neutral',
      minify: false,
      // @livething/core is an external peer in the built packages; keep it external
      // here too so we only inspect each package's own code.
      external: [
        '@livething/core',
        '@livething/core/*',
        '@standard-schema/*',
        ...(options.external ?? []),
      ],
      logLevel: 'silent',
    });
    return result.outputFiles.map((file) => file.text).join('\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runNodeAdapterSuite() {
  console.log('\n@livething/server-node');
  const failures = [];

  await assertMarkersResolve(
    NODE_ADAPTER_DIST,
    { runtime: { marker: NODE_ADAPTER_MARKER, label: 'Node adapter runtime' } },
    failures,
  );

  try {
    const code = await bundle(importStar(join(NODE_ADAPTER_DIST, 'index.js')), {
      platform: 'node',
      external: [
        'node:*',
        '@livething/server',
        '@livething/server/*',
        '@fastify/*',
        'better-sqlite3',
        'ws',
      ],
    });

    if (!code.includes(NODE_ADAPTER_MARKER)) {
      failures.push(
        `  [@livething/server-node · index] expected Node adapter runtime marker ${JSON.stringify(NODE_ADAPTER_MARKER)} is absent`,
      );
    }

    if (code.includes('cloudflare:workers')) {
      failures.push(
        '  [@livething/server-node · index] Cloudflare runtime code leaked into the Node adapter bundle',
      );
    }

    console.log(`  ${failures.length ? '✗' : '✓'} index (runtime)`);
  } catch (error) {
    failures.push(
      `  [@livething/server-node · index] could not bundle the public entry — ${error instanceof Error ? error.message : String(error)}`,
    );
    console.log('  ✗ index (runtime)');
  }

  return failures;
}

async function runSuite(suite, scenarios) {
  const { label, distDir, engines } = suite;
  console.log(`\n${label}`);
  const failures = [];

  await assertMarkersResolve(distDir, engines, failures);

  for (const scenario of scenarios) {
    // `owns` is normally one engine id, but a scenario can legitimately own more
    // than one (for example `channels()` owns both the wire runtime and the
    // membership table it creates), so it also accepts an array.
    const owned = new Set(
      Array.isArray(scenario.owns) ? scenario.owns : [scenario.owns].filter(Boolean),
    );
    const allowed = new Set([...owned, ...scenario.alsoPulls]);
    const code = await bundle(scenario.source);
    const present = new Set(Object.keys(engines).filter((id) => code.includes(engines[id].marker)));

    // 1. Leak: an engine that should NOT be here showed up.
    for (const id of present) {
      if (!allowed.has(id)) {
        failures.push(
          `  [${label} · ${scenario.name}] leaked ${engines[id].label} — marker ${JSON.stringify(engines[id].marker)} found`,
        );
      }
    }

    // 2. Drift: an engine we expect (own or documented dependency) is missing —
    //    either the marker was renamed or the dependency genuinely changed. Fix
    //    the marker, or update `owns`/`alsoPulls` for this scenario.
    for (const id of allowed) {
      if (!present.has(id)) {
        const kind = owned.has(id) ? 'own engine' : 'documented dependency';
        failures.push(
          `  [${label} · ${scenario.name}] expected ${kind} ${engines[id].label} is absent — marker drift or dependency removed`,
        );
      }
    }

    const leaked = [...present].filter((id) => !allowed.has(id));
    console.log(`  ${leaked.length ? '✗' : '✓'} ${scenario.name}`);
  }

  return failures;
}

// Guard against a stale/renamed marker silently passing every ABSENCE check.
// Each marker must be findable SOMEWHERE in the built dist on disk; otherwise
// "marker absent" would mean "renamed", not "tree-shaken". A marker can live in
// a runtime chunk no entry statically imports (that is the whole point of the
// split), so we scan the dist files directly rather than bundling.
async function assertMarkersResolve(distDir, engines, failures) {
  let files;
  try {
    files = await collectJsFiles(distDir);
  } catch {
    failures.push(`  could not read ${distDir} — run the package build first (pnpm build)`);
    return;
  }

  const haystack = (await Promise.all(files.map((f) => readFile(f, 'utf8')))).join('\n');
  for (const [id, { marker }] of Object.entries(engines)) {
    if (!haystack.includes(marker)) {
      failures.push(
        `  marker for ${id} not found in ${distDir} — it was renamed or removed; update scripts/bundle-check.mjs`,
      );
    }
  }
}

// Every `.js` file under a dist tree (server dist is flat; the client emits
// nested per-module folders, so this has to recurse).
async function collectJsFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await collectJsFiles(full)));
    else if (entry.name.endsWith('.js')) out.push(full);
  }

  return out;
}

// Resolve a dist file name against a package's dist directory.
function withDir(dir) {
  return (file) => join(dir, file);
}

async function main() {
  const failures = [
    ...(await runSuite(
      { label: '@livething/server', distDir: SERVER_DIST, engines: SERVER_ENGINES },
      serverScenarios(withDir(SERVER_DIST)),
    )),
    ...(await runSuite(
      { label: '@livething/client', distDir: CLIENT_DIST, engines: CLIENT_ENGINES },
      clientScenarios(withDir(CLIENT_DIST)),
    )),
    ...(await runNodeAdapterSuite()),
  ];

  if (failures.length) {
    console.error('\nbundle-check: tree-shaking matrix mismatch:');
    console.error(failures.join('\n'));
    console.error(
      '\nA LEAK is a real architecture violation — forbidden engine code reached a bundle ' +
        'that should not contain it. Do not loosen the assertion; fix the import edge.\n' +
        'A DRIFT means a marker was renamed or a dependency changed — update this script to match.',
    );
    process.exit(1);
  }

  console.log(
    '\nbundle-check: all entries clean — optional feature code is only included where it is needed.',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
