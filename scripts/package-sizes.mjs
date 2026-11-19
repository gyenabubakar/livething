// Measures what the built packages (their dist) add to a real app, and writes the numbers
// to website/app/package-sizes.json, which the docs read through <PackageSize>. The root
// postinstall and the website scripts run this. After you change package code, run
// `pnpm build` so the numbers follow.
//
// Client sizes are minified and gzipped, because browsers download them. Server sizes are
// minified only: nobody downloads server code. Each app bundles @livething/core and
// valibot, and leaves out the runtime's own modules, `ws`, `better-sqlite3` and web
// frameworks, which the app installs itself. All sizes are in bytes.

import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(repo, 'website/app/package-sizes.json');

const CLIENT_PRIMITIVES = [
  'reconnection',
  'keepalive',
  'buffering',
  'intercept',
  'platform',
  'channels',
  'clientRequests',
  'serverRequests',
  'dedup',
  'replay',
  'gaps',
  'inbox',
  'readReceipts',
  'awareness',
  'stream',
  'binary',
  'uploads',
];

const SERVER_CAPABILITY_PATHS = [
  './client-requests',
  './server-requests',
  './scheduled',
  './dedup',
  './sequence',
  './keepalive',
  './rate-limit',
  './replay',
  './inbox',
  './awareness',
  './last-seen',
  './streams',
  './channels',
  './binary',
  './uploads',
  './tags',
  './plugins',
];

const ADAPTERS = [
  ['cloudflare', 'server-adapters/cloudflare', '.'],
  ['node', 'server-adapters/node', '.'],
  ['node/binding', 'server-adapters/node', './binding'],
  ['node/hono', 'server-adapters/node', './hono'],
  ['node/fastify', 'server-adapters/node', './fastify'],
  ['node/h3', 'server-adapters/node', './h3'],
  ['node/h3/v1', 'server-adapters/node', './h3/v1'],
];

const SERVER_EXTERNAL = [
  'node:*',
  'cloudflare:*',
  'ws',
  'better-sqlite3',
  'hono',
  'hono/*',
  '@hono/*',
  'fastify',
  '@fastify/*',
  'h3',
  'crossws',
  'crossws/*',
];

/** The built file a package exports at `subpath`, read from its package.json. */
async function entry(packageDir, subpath = '.') {
  const manifest = JSON.parse(await readFile(join(repo, packageDir, 'package.json'), 'utf8'));
  const target = manifest.exports[subpath];
  const file = join(repo, packageDir, typeof target === 'string' ? target : target.import);
  if (!existsSync(file)) {
    console.error(`${file} does not exist. Run \`pnpm build\` first, then run this script again.`);
    process.exit(1);
  }

  return file;
}

async function bundleSize(source, options) {
  const dir = await mkdtemp(join(tmpdir(), 'livething-size-'));
  const file = join(dir, 'app.mjs');
  await writeFile(file, source);
  try {
    const result = await build({
      entryPoints: [file],
      bundle: true,
      write: false,
      format: 'esm',
      platform: options.platform,
      minify: true,
      external: options.external ?? [],
      logLevel: 'silent',
    });
    const code = result.outputFiles[0].contents;
    return options.gzip ? gzipSync(code).length : code.length;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function clientSize(primitives) {
  const index = JSON.stringify(await entry('client'));
  const source = `
    import { client, connect${primitives.map((name) => `, ${name}`).join('')} } from ${index};
    export const socket = client()(connect('wss://huddle.example/huddle')${primitives.map((name) => `, ${name}()`).join('')});
    socket.on('message-created', (message) => console.log(message));
    socket.send('send-message', { text: 'hello' });
  `;
  return bundleSize(source, { platform: 'browser', gzip: true });
}

async function serverSize(adapter, capabilityPaths = []) {
  const imports = [`import { server } from ${JSON.stringify(await entry('server'))};`];
  const used = ['huddle'];
  for (const [index, path] of capabilityPaths.entries()) {
    imports.push(
      `import * as capability${index} from ${JSON.stringify(await entry('server', path))};`,
    );
    used.push(`capability${index}`);
  }

  const [, packageDir, subpath] = adapter;
  imports.push(`import * as adapter from ${JSON.stringify(await entry(packageDir, subpath))};`);
  used.push('adapter');

  const source = `${imports.join('\n')}
    const huddle = server({}).assemble({ handlers: [] });
    export { ${used.join(', ')} };
  `;

  return bundleSize(source, { platform: 'node', gzip: false, external: SERVER_EXTERNAL });
}

const [clientMinimal, clientAll, clientBinary] = await Promise.all([
  clientSize([]),
  clientSize(CLIENT_PRIMITIVES),
  clientSize(['binary']),
]);

const adapters = {};
for (const adapter of ADAPTERS) {
  adapters[adapter[0]] = {
    minimal: await serverSize(adapter),
    all: await serverSize(adapter, SERVER_CAPABILITY_PATHS),
  };
}

// Measured on a Node app, so the engine is in both bundles and only the channel code differs.
const nodeAdapter = ADAPTERS.find((adapter) => adapter[0] === 'node');
const nodeWithChannels = await serverSize(nodeAdapter, ['./channels']);

const sizes = {
  client: { minimal: clientMinimal, all: clientAll, binary: clientBinary - clientMinimal },
  server: { channels: nodeWithChannels - adapters.node.minimal, adapters },
};

await writeFile(output, `${JSON.stringify(sizes, null, 2)}\n`);
console.log(`package sizes written to ${output}`);
