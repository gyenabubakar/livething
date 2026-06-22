// Tree-shaking guard for wskit (server spec §24). Bundles a few import
// scenarios from the BUILT `@wskit/server` with esbuild and asserts — via the
// emitted code — that forbidden engine code is absent. A minimal server must
// bundle only core; importing one capability must pull only that capability's
// engine.
//
// Markers are stable string literals that survive minification and live in
// exactly one engine's built chunk (verified against server/dist):
//   - durable streams  → "__wskit_stream_chunks" (durable-stream SQL schema)
//   - channel runtime  → "__subscribeOk__"        (channel wire-frame tag)
//   - rate-limit engine→ " at scope "             (rate-limit plan resolver)
// We assert MARKER ABSENCE, never byte size (brittle).

import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const serverDist = resolve(repoRoot, 'server/dist');

// Resolve the built entry files directly so the check does not depend on the
// package being linked into node_modules.
const ENTRY = {
  index: join(serverDist, 'index.js'),
  channels: join(serverDist, 'channels.js'),
  streams: join(serverDist, 'streams.js'),
};

const MARKER = {
  durableStream: '__wskit_stream_chunks',
  channelRuntime: '__subscribeOk__',
  rateLimit: ' at scope ',
};

/** One import scenario: source to bundle, plus markers that must be absent. */
const SCENARIOS = [
  {
    name: 'minimal server (define + emits only)',
    source: `import { define, emits } from ${JSON.stringify(ENTRY.index)};
export { define, emits };`,
    forbidden: [
      ['durable-stream engine', MARKER.durableStream],
      ['channel runtime', MARKER.channelRuntime],
      ['rate-limit engine', MARKER.rateLimit],
    ],
  },
  {
    name: 'channels only',
    source: `import { channels } from ${JSON.stringify(ENTRY.channels)};
export { channels };`,
    forbidden: [
      ['durable-stream engine', MARKER.durableStream],
      ['rate-limit engine', MARKER.rateLimit],
    ],
  },
  {
    name: 'stream (plain) only',
    // Import only the plain `stream` from the streams barrel; the resumable and
    // recorded variants (and their durable-sweep engine) must tree-shake away,
    // and rate limiting must not come along.
    source: `import { stream } from ${JSON.stringify(ENTRY.streams)};
export { stream };`,
    forbidden: [
      ['durable-stream engine', MARKER.durableStream],
      ['rate-limit engine', MARKER.rateLimit],
    ],
  },
];

async function bundle(source) {
  const dir = await mkdtemp(join(tmpdir(), 'wskit-bundle-check-'));
  const entry = join(dir, 'entry.mjs');
  await writeFile(entry, source);
  try {
    const result = await build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'neutral',
      minify: false,
      metafile: true,
      // @wskit/core is an external peer in the built server; keep it external
      // here too so we only inspect the server's own code.
      external: ['@wskit/core', '@wskit/core/*', '@standard-schema/*'],
      logLevel: 'silent',
    });
    return {
      code: result.outputFiles.map((f) => f.text).join('\n'),
      inputs: Object.keys(result.metafile.inputs),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function main() {
  // Sanity: confirm the dist exists and each marker is actually present
  // somewhere in dist, so an absent marker means "tree-shaken", not "renamed".
  await assertMarkersExist();

  const failures = [];
  for (const scenario of SCENARIOS) {
    const { code } = await bundle(scenario.source);
    for (const [label, marker] of scenario.forbidden) {
      if (code.includes(marker)) {
        failures.push(
          `  [${scenario.name}] leaked ${label} — found marker ${JSON.stringify(marker)}`,
        );
      }
    }
    const present = scenario.forbidden.filter(([, m]) => code.includes(m)).map(([l]) => l);
    const verdict = present.length ? 'LEAK' : 'ok';
    console.log(`  ${verdict === 'ok' ? '✓' : '✗'} ${scenario.name}`);
  }

  if (failures.length) {
    console.error('\nbundle-check: tree-shaking leak(s) detected:');
    console.error(failures.join('\n'));
    console.error(
      '\nThis is a REAL architecture violation — forbidden engine code reached a ' +
        'bundle that should not contain it. Do not loosen the assertion; fix the import edge.',
    );
    process.exit(1);
  }
  console.log('\nbundle-check: all scenarios clean — no forbidden engine code leaked.');
}

// Guard against a stale/renamed marker silently passing. Each marker must be
// findable SOMEWHERE in the built dist on disk; otherwise the absence
// assertions are meaningless. A marker can live in a runtime chunk that no
// capability entry statically imports (that is the whole point of the split),
// so we scan the dist files directly rather than bundling.
async function assertMarkersExist() {
  let files;
  try {
    files = (await readdir(serverDist)).filter((f) => f.endsWith('.js'));
  } catch (err) {
    console.error(
      'bundle-check: could not read server/dist. Run `pnpm --filter @wskit/server build` first.',
    );
    throw err;
  }
  const haystack = (
    await Promise.all(files.map((f) => readFile(join(serverDist, f), 'utf8')))
  ).join('\n');
  const missing = Object.entries(MARKER).filter(([, m]) => !haystack.includes(m));
  if (missing.length) {
    console.error(
      'bundle-check: marker(s) not found in the built output — they were renamed or removed:',
    );
    for (const [k, m] of missing) console.error(`  ${k}: ${JSON.stringify(m)}`);
    console.error('Update the markers in scripts/bundle-check.mjs to match the current build.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
