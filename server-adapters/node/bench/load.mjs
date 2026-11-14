// End-to-end load benchmark for the Node adapter. It forks the server (`load-server.mjs`), opens
// many real WebSocket clients and reports the server's CPU time and memory for each step.
//
//   node bench/load.mjs [livething|ws] [connections]
//
// `ws` runs the same app on plain `ws`, so the two runs show what LiveThing adds.
import { fork } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const mode = process.argv[2] ?? 'livething';
const connectionCount = Number(process.argv[3] ?? 5000);
// The small-room steps put every connection in a room of 10.
if (connectionCount % 10 !== 0) throw new Error('Use a connection count that is a multiple of 10.');
const transport = process.env.LOAD_TRANSPORT ?? 'websocket';

// LOAD_BASELINE=<dir> runs the server from another copy of the packages (a `node_modules` in
// that folder), to compare a change with the build before it.
let serverScript = fileURLToPath(new URL('./load-server.mjs', import.meta.url));
if (process.env.LOAD_BASELINE) {
  const benchCopy = join(process.env.LOAD_BASELINE, 'bench');
  mkdirSync(benchCopy, { recursive: true });
  for (const file of ['load-server.mjs', 'huddle-definition.mjs']) {
    copyFileSync(join(dirname(serverScript), file), join(benchCopy, file));
  }

  serverScript = join(benchCopy, 'load-server.mjs');
}

const serverProcess = fork(serverScript, [mode], {
  execArgv: ['--expose-gc', ...(process.env.LOAD_SERVER_FLAGS?.split(' ').filter(Boolean) ?? [])],
});
// A crash here must not leave the server running, or a caller waiting on it never ends.
process.on('exit', () => serverProcess.kill());
const { port } = await new Promise((resolve) => serverProcess.once('message', resolve));

function callServer(message) {
  return new Promise((resolve) => {
    serverProcess.once('message', resolve);
    serverProcess.send(message);
  });
}

function serverStats() {
  return callServer('stats');
}

// LOAD_PROFILE=<dir> writes one server CPU profile per step there.
const profileDir = process.env.LOAD_PROFILE;
// LOAD_STEPS="echo,fan-out" measures only the steps whose names start with these words.
const onlySteps = process.env.LOAD_STEPS?.split(',').filter(Boolean);

const counts = new Map();
let wake = noop;

function noop() {}

function countFrame(data) {
  const text = typeof data === 'string' ? data : data.toString();
  const event = text.slice(2, text.indexOf('"', 2));
  counts.set(event, (counts.get(event) ?? 0) + 1);
  wake();
}

function waitFor(condition, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      wake = () => {};
      reject(new Error(`Timed out: ${label} (${JSON.stringify(Object.fromEntries(counts))})`));
    }, 120_000);
    wake = () => {
      if (!condition()) return;

      clearTimeout(timer);
      wake = () => {};
      resolve();
    };
    wake();
  });
}

function count(event) {
  return counts.get(event) ?? 0;
}

function openClient(index) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/huddle?user=u${index}`, ['livething-v1'], {
      perMessageDeflate: false,
    });
    socket.on('message', countFrame);
    socket.once('message', () => resolve(socket));
    socket.once('error', reject);
  });
}

async function openClients(n, concurrency = 100) {
  const clients = new Array(n);
  let next = 0;
  async function worker() {
    while (next < n) {
      const index = next++;
      clients[index] = await openClient(index);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  await waitFor(() => count('__connected__') >= n, 'connected');

  return clients;
}

const results = [];

async function step(name, measure, run) {
  const { units, unit: unitLabel } = measure;

  const measured = !onlySteps || onlySteps.some((prefix) => name.startsWith(prefix));
  const before = await serverStats();
  if (measured && profileDir) await callServer('profile-start');
  const started = performance.now();
  await run();

  const wallMs = performance.now() - started;
  if (measured && profileDir) {
    await callServer({ profileTo: `${profileDir}/${name.replaceAll(' ', '-')}.cpuprofile` });
  }

  const after = await serverStats();
  if (!measured) return { before, after };

  const cpuUs = after.cpu.user + after.cpu.system - (before.cpu.user + before.cpu.system);
  const row = {
    step: name,
    units,
    unit: unitLabel,
    wallMs: Math.round(wallMs),
    serverCpuMs: Math.round(cpuUs / 1000),
    cpuUsPerUnit: Number((cpuUs / units).toFixed(3)),
    unitsPerSec: Math.round(units / (wallMs / 1000)),
    heapDeltaMB: Number(((after.memory.heapUsed - before.memory.heapUsed) / 2 ** 20).toFixed(1)),
    rssMB: Math.round(after.memory.rss / 2 ** 20),
  };

  results.push(row);
  console.error(JSON.stringify(row));

  return { before, after };
}

function channel(name) {
  return { channel: { name, family: 'rooms' } };
}

function startCounts() {
  counts.clear();
}

const baseline = await serverStats();
let clients;
const connect = await step('connect', { units: connectionCount, unit: 'connection' }, async () => {
  clients = await openClients(connectionCount);
});
const connectRow = results.find((row) => row.step === 'connect');
if (connectRow) {
  connectRow.heapBytesPerConnection = Math.round(
    (connect.after.memory.heapUsed - baseline.memory.heapUsed) / connectionCount,
  );
}

const echoesEach = 10;
await step('echo', { units: connectionCount * echoesEach, unit: 'message' }, async () => {
  startCounts();
  const frame = JSON.stringify(['echo', { text: 'hello there' }, null]);
  for (const socket of clients) for (let i = 0; i < echoesEach; i++) socket.send(frame);
  await waitFor(() => count('echoed') >= connectionCount * echoesEach, 'echo');
});

await step('request', { units: connectionCount * echoesEach, unit: 'request' }, async () => {
  startCounts();
  let id = 0;
  for (const socket of clients) {
    for (let i = 0; i < echoesEach; i++) {
      socket.send(
        JSON.stringify(['get-profile', null, { exchange: { id: `r${id++}`, source: 'client' } }]),
      );
    }
  }

  await waitFor(() => count('get-profile') >= connectionCount * echoesEach, 'request');
});

const roomSize = 10;
const roomCount = connectionCount / roomSize;
await step(
  `join ${roomCount} rooms of ${roomSize}`,
  { units: connectionCount, unit: 'join' },
  async () => {
    startCounts();
    clients.forEach((socket, index) => {
      socket.send(
        JSON.stringify(['__subscribe__', null, channel(`room:small${index % roomCount}`)]),
      );
    });
    await waitFor(() => count('__subscribeOk__') >= connectionCount, 'small join');
    if (mode === 'livething') {
      const pairs = roomCount * ((roomSize * (roomSize - 1)) / 2);
      await waitFor(() => count('__memberOnline__') >= pairs, 'small join presence');
    }
  },
);

const smallSends = 5;
// A broadcast from a handler skips its sender, so each send reaches the room minus one.
const smallDeliveries = connectionCount * smallSends * (roomSize - 1);
await step(
  `send in rooms of ${roomSize}`,
  { units: smallDeliveries, unit: 'delivery' },
  async () => {
    startCounts();
    clients.forEach((socket, index) => {
      const frame = JSON.stringify([
        'send-message',
        { text: 'hi all' },
        channel(`room:small${index % roomCount}`),
      ]);
      for (let i = 0; i < smallSends; i++) socket.send(frame);
    });
    await waitFor(() => count('message') >= smallDeliveries, 'small send');
  },
);

// LOAD_BIG_ROOMS="" skips these joins (they are slow on purpose) and the fan-out that uses them.
const bigRooms = (process.env.LOAD_BIG_ROOMS ?? '500,1000,2000')
  .split(',')
  .filter(Boolean)
  .map(Number)
  .filter((size) => size <= connectionCount);
for (const size of bigRooms) {
  await step(`join one room of ${size}`, { units: size, unit: 'join' }, async () => {
    startCounts();
    for (let i = 0; i < size; i++) {
      clients[i].send(JSON.stringify(['__subscribe__', null, channel(`room:big${size}`)]));
    }

    await waitFor(() => count('__subscribeOk__') >= size, 'big join');
    if (mode === 'livething') {
      await waitFor(
        () => count('__memberOnline__') >= (size * (size - 1)) / 2,
        'big join presence',
      );
    }
  });
}

const fanOutSize = bigRooms.at(-1);
const senders = 20;
const sendsEach = 10;
const fanOutDeliveries = senders * sendsEach * (fanOutSize - 1);
if (fanOutSize) {
  await step(
    `fan-out to ${fanOutSize}`,
    { units: fanOutDeliveries, unit: 'delivery' },
    async () => {
      startCounts();
      const frame = JSON.stringify([
        'send-message',
        { text: 'hello room' },
        channel(`room:big${fanOutSize}`),
      ]);
      for (let s = 0; s < senders; s++) for (let i = 0; i < sendsEach; i++) clients[s].send(frame);
      await waitFor(() => count('message') >= fanOutDeliveries, 'fan-out');
    },
  );
}

await step('disconnect', { units: connectionCount, unit: 'connection' }, async () => {
  await Promise.all(
    clients.map(
      (socket) =>
        new Promise((resolve) => {
          socket.once('close', resolve);
          socket.close(1000);
        }),
    ),
  );
  // The server's close handlers run after the client sees the close.
  await new Promise((resolve) => setTimeout(resolve, 500));
});

const end = await serverStats();
console.log(
  JSON.stringify({
    mode,
    transport,
    connections: connectionCount,
    heapLeftAfterCloseMB: Number(
      ((end.memory.heapUsed - baseline.memory.heapUsed) / 2 ** 20).toFixed(1),
    ),
    results,
  }),
);
serverProcess.send('exit');
await new Promise((resolve) => serverProcess.once('exit', resolve));
process.exit(0);
