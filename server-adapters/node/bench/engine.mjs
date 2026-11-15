// The process CPU time and memory of the LiveThing engine, with no sockets. Each connection is a
// transport that only counts the frames the engine hands it, so the numbers leave out the kernel
// and `ws`. They include this script's own small loop that sends the frames and waits.
//
//   node --expose-gc bench/engine.mjs [connections]
//
// ENGINE_BIG_ROOM sets the size of the one big room (default 1000; 0 skips it).
import { binding } from '@livething/server-node/binding';
import { buildHuddleDefinition } from './huddle-definition.mjs';

const connectionCount = Number(process.argv[2] ?? 5000);
// The small-room steps put every connection in a room of 10.
if (connectionCount % 10 !== 0) throw new Error('Use a connection count that is a multiple of 10.');
const bigRoomSize = Math.min(Number(process.env.ENGINE_BIG_ROOM ?? 1000), connectionCount);
const huddleEndpoint = binding().bind(buildHuddleDefinition(), {
  logger: { debug() {}, info() {}, warn() {}, error: console.error },
});
await huddleEndpoint.ready();

const counts = new Map();
function countFrame(frame) {
  const text = frame.kind === 'text' ? frame.text : '';
  const event = text.slice(2, text.indexOf('"', 2));
  counts.set(event, (counts.get(event) ?? 0) + 1);
}

function count(event) {
  return counts.get(event) ?? 0;
}

function transport() {
  return {
    send(frame) {
      countFrame(frame);
      return true;
    },
    close() {},
    terminate() {},
    bufferedAmount: () => 0,
    backpressureSupported: true,
  };
}

async function connect(index) {
  const upgrade = await huddleEndpoint.prepare(
    new Request(`http://127.0.0.1/huddle?user=u${index}`),
  );
  if (upgrade.type !== 'accept') throw new Error(`Not accepted: ${upgrade.type}`);

  return upgrade.accept(transport());
}

function heapUsed() {
  globalThis.gc?.();
  globalThis.gc?.();
  return process.memoryUsage().heapUsed;
}

// Presence changes wait up to one batch window, so a step that joins or leaves waits for the
// window to end, and the batch counts in that step.
function presenceWindowEnds() {
  return new Promise((resolve) => setTimeout(resolve, 1100));
}

// Let the engine's background work (onConnect, frames still in line) finish.
function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}

const results = [];
async function step(name, measure, run) {
  await settle();
  // Collect first, so the garbage of the step before is not counted in this one.
  globalThis.gc?.();
  const cpuBefore = process.cpuUsage();
  const started = performance.now();
  await run();
  await settle();

  const wallMs = performance.now() - started;
  const cpu = process.cpuUsage(cpuBefore);
  const row = {
    step: name,
    ...measure,
    nsPerUnit: Math.round(((cpu.user + cpu.system) * 1000) / measure.units),
    wallMs: Math.round(wallMs),
  };

  results.push(row);
  console.error(JSON.stringify(row));
}

function channel(name) {
  return { channel: { name, family: 'rooms' } };
}

const heapBefore = heapUsed();
let connections = [];
await step('connect', { units: connectionCount, unit: 'connection' }, async () => {
  for (let i = 0; i < connectionCount; i += 500) {
    const batch = [];
    for (let j = i; j < Math.min(i + 500, connectionCount); j++) batch.push(connect(j));
    connections.push(...(await Promise.all(batch)));
  }
});
const heapBytesPerConnection = Math.round((heapUsed() - heapBefore) / connectionCount);

const perConnection = 10;
// One message at a time, as a server sees them: Node runs each socket's message, and the
// promise work it starts, before it reads the next one.
async function sendAll(frameFor) {
  for (let i = 0; i < perConnection; i++) {
    for (let index = 0; index < connections.length; index++) {
      await connections[index].message(frameFor(index, i));
    }
  }
}

// Frames are built before each step, so the step's CPU time is the engine's.
function frames(frameFor) {
  return Array.from({ length: perConnection }, (_unused, i) =>
    connections.map((_connection, index) => frameFor(index, i)),
  );
}

const echoFrames = frames(() => JSON.stringify(['echo', { text: 'hello there' }, null]));
await step('echo', { units: connectionCount * perConnection, unit: 'message' }, async () => {
  await sendAll((index, i) => echoFrames[i][index]);
  if (count('echoed') < connectionCount * perConnection) throw new Error('echo lost frames');
});

const requestFrames = frames((index, i) =>
  JSON.stringify(['get-profile', null, { exchange: { id: `r${index}-${i}`, source: 'client' } }]),
);
await step('request', { units: connectionCount * perConnection, unit: 'request' }, async () => {
  await sendAll((index, i) => requestFrames[i][index]);
  if (count('get-profile') < connectionCount * perConnection) {
    throw new Error('request lost frames');
  }
});

const roomSize = 10;
const roomCount = Math.ceil(connectionCount / roomSize);
function smallRoom(index) {
  return channel(`room:small${index % roomCount}`);
}

const joinFrames = connections.map((_connection, index) =>
  JSON.stringify(['__subscribe__', null, smallRoom(index)]),
);
await step(`join rooms of ${roomSize}`, { units: connectionCount, unit: 'join' }, async () => {
  for (let index = 0; index < connectionCount; index++) {
    await connections[index].message(joinFrames[index]);
  }

  await presenceWindowEnds();
});

counts.clear();
const smallFrames = frames((index) =>
  JSON.stringify(['send-message', { text: 'hi all' }, smallRoom(index)]),
);
const smallDeliveries = connectionCount * perConnection * (roomSize - 1);
await step(
  `send in rooms of ${roomSize}`,
  { units: smallDeliveries, unit: 'delivery' },
  async () => {
    await sendAll((index, i) => smallFrames[i][index]);
    if (count('message') !== smallDeliveries) {
      throw new Error(`small rooms delivered ${count('message')}`);
    }
  },
);

if (bigRoomSize > 0) {
  const bigJoin = JSON.stringify(['__subscribe__', null, channel('room:big')]);
  await step(`join one room of ${bigRoomSize}`, { units: bigRoomSize, unit: 'join' }, async () => {
    for (let i = 0; i < bigRoomSize; i++) await connections[i].message(bigJoin);
    await presenceWindowEnds();
  });

  counts.clear();
  const sends = 100;
  const deliveries = sends * (bigRoomSize - 1);
  const bigFrame = JSON.stringify(['send-message', { text: 'hello room' }, channel('room:big')]);
  await step(`fan-out to ${bigRoomSize}`, { units: deliveries, unit: 'delivery' }, async () => {
    // Only members of the room can send to it, so a room smaller than 20 has fewer senders.
    const senders = Math.min(20, bigRoomSize);
    for (let i = 0; i < sends; i++) await connections[i % senders].message(bigFrame);
    if (count('message') !== deliveries) throw new Error('fan-out lost frames');
  });
}

await step('disconnect', { units: connectionCount, unit: 'connection' }, async () => {
  for (const connection of connections) await connection.close(1000, '');
  await presenceWindowEnds();
});
connections = [];

const report = JSON.stringify({
  connections: connectionCount,
  heapBytesPerConnection,
  heapLeftAfterCloseBytes: heapUsed() - heapBefore,
  results,
});
// A pipe to stdout can write after this line returns, so exit once the report is out.
process.stdout.write(`${report}\n`, () => process.exit(0));
