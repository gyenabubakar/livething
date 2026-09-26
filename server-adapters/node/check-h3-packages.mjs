import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const packageDirectory = dirname(fileURLToPath(import.meta.url));
const workspace = resolve(packageDirectory, '../..');
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'livething-h3-packages-'));
const tarballDirectory = join(temporaryDirectory, 'tarballs');

try {
  const core = await pack(join(workspace, 'core'));
  const server = await pack(join(workspace, 'server'));
  const node = await pack(packageDirectory);

  await checkConsumer('v1', {
    '@livething/core': `file:${core}`,
    '@livething/server': `file:${server}`,
    '@livething/server-node': `file:${node}`,
    '@types/better-sqlite3': '^9.6.0',
    '@types/node': '^24.12.0',
    '@types/ws': '^8.5.12',
    crossws: '0.3.5',
    h3: '1.15.11',
    typescript: '6.0.2',
    ws: '^8.18.0',
  });
  await checkConsumer('v2', {
    '@livething/core': `file:${core}`,
    '@livething/server': `file:${server}`,
    '@livething/server-node': `file:${node}`,
    '@types/better-sqlite3': '^9.6.0',
    '@types/node': '^24.12.0',
    '@types/ws': '^8.5.12',
    crossws: '0.4.12',
    h3: '2.0.1-rc.31',
    typescript: '6.0.2',
    ws: '^8.18.0',
  });
} finally {
  await rm(temporaryDirectory, { force: true, recursive: true });
}

async function pack(directory) {
  const before = new Set(await readdir(tarballDirectory).catch(() => []));
  await exec('pnpm', ['pack', '--pack-destination', tarballDirectory], { cwd: directory });
  const filename = (await readdir(tarballDirectory)).find((item) => !before.has(item));
  if (!filename) throw new Error(`pnpm pack produced no tarball for ${directory}`);

  return join(tarballDirectory, filename);
}

async function checkConsumer(version, dependencies) {
  const directory = join(temporaryDirectory, `h3-${version}`);
  await writeFile(
    join(temporaryDirectory, '.npmrc'),
    'auto-install-peers=false\nstrict-peer-dependencies=true\n',
  );
  await mkdir(directory);
  await writeFile(
    join(directory, 'package.json'),
    `${JSON.stringify(
      {
        private: true,
        type: 'module',
        dependencies,
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(join(directory, 'pnpm-workspace.yaml'), 'allowBuilds:\n  better-sqlite3: true\n');

  await writeFile(
    join(directory, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          lib: ['ES2024', 'DOM'],
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          noEmit: true,
          skipLibCheck: version === 'v2',
          strict: true,
          target: 'ES2024',
        },
        include: ['globals.d.ts', 'probe.ts'],
      },
      null,
      2,
    )}\n`,
  );

  await writeFile(
    join(directory, 'globals.d.ts'),
    'interface FetchEvent { respondWith(response: Response | PromiseLike<Response>): void }\n',
  );
  await writeFile(join(directory, 'probe.ts'), probeSource(version));
  await exec('pnpm', ['install', '--prefer-offline'], { cwd: directory });
  await exec('pnpm', ['exec', 'tsc'], { cwd: directory });
  await exec('node', ['--experimental-strip-types', 'probe.ts'], { cwd: directory });
}

function probeSource(version) {
  if (version === 'v1') {
    return `import { createServer } from 'node:http';
import { server as defineServer, emits, t } from '@livething/server';
import { setup } from '@livething/server-node/h3/v1';
import nodeWebSocketAdapter from 'crossws/adapters/node';
import { createApp, createRouter, toNodeListener } from 'h3';
import WebSocket from 'ws';

const base = defineServer({
  upgrade() { return { userId: 'packed-v1' }; },
  capabilities: [emits({ ready: t<{ version: string }>() })],
});
base.onConnect((ctx) => { ctx.send('ready', { version: 'v1' }); });
const definition = base.assemble({ handlers: [] });
const livething = setup();
const endpoint = livething.bind(definition, { sql: ':memory:' });
if (false) {
  // @ts-expect-error H3 v1 cannot safely derive the Node client IP
  livething.bind(definition, { clientIp: { mode: 'direct' } });
}
const app = createApp();
const router = createRouter();
router.get('/ws', endpoint.upgrade);
app.use(router);
const websocket = nodeWebSocketAdapter(app.websocket);
const http = createServer(toNodeListener(app));
http.on('upgrade', websocket.handleUpgrade);
await livething.ready();
await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
const address = http.address();
if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
const socket = new WebSocket(\`ws://127.0.0.1:\${address.port}/ws\`);
const message = await new Promise<string>((resolve, reject) => {
  socket.once('message', (data) => resolve(data.toString()));
  socket.once('error', reject);
});
if (message !== '["ready",{"version":"v1"},null]') throw new Error(message);
const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
await livething.shutdown();
await closed;
await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()));
`;
  }

  return `import { server as defineServer, emits, t } from '@livething/server';
import { setup } from '@livething/server-node/h3';
import { serve } from 'crossws/server/node';
import { H3 } from 'h3/node';
import WebSocket from 'ws';

const base = defineServer({
  upgrade() { return { userId: 'packed-v2' }; },
  capabilities: [emits({ ready: t<{ version: string }>() })],
});
base.onConnect((ctx) => { ctx.send('ready', { version: 'v2' }); });
const livething = setup();
const endpoint = livething.bind(base.assemble({ handlers: [] }), { sql: ':memory:' });
const app = new H3();
app.get('/ws', endpoint.upgrade);
await livething.ready();
const served = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0, websocket: {} });
const http = served.node?.server;
if (!http) throw new Error('Expected a Node server');
await new Promise<void>((resolve, reject) => {
  if (http.listening) resolve();
  else { http.once('listening', resolve); http.once('error', reject); }
});
const address = http.address();
if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
const socket = new WebSocket(\`ws://127.0.0.1:\${address.port}/ws\`);
const message = await new Promise<string>((resolve, reject) => {
  socket.once('message', (data) => resolve(data.toString()));
  socket.once('error', reject);
});
if (message !== '["ready",{"version":"v2"},null]') throw new Error(message);
const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
await livething.shutdown();
await closed;
await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()));
`;
}
