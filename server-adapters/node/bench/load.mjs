// End-to-end load benchmark for the Node adapter. It forks the server (`load-server.mjs`), opens
// many real clients and reports the server's CPU time and memory for each step.
//
//   node bench/load.mjs [mode] [connections]
//
// Modes:
//   livething           LiveThing over WebSocket
//   livething-sse       LiveThing over server-sent events (a stream, and POSTs from the client)
//   ws                  the same app on plain `ws`, to show what LiveThing adds
//   socket.io           the same app on Socket.IO over WebSocket
//   socket.io-polling   the same app on Socket.IO over HTTP long-polling, its fallback
//
// Environment variables:
//   LOAD_PRESENCE=off     turn presence off on LiveThing
//   LOAD_BINARY_SIZES     sizes of the binary steps in bytes (default 1024,65536; empty skips them)
//   LOAD_BIG_ROOMS        sizes of the one-room join steps (default 500,1000,2000; empty skips them)
//   LOAD_STEPS            measure only the steps whose names start with these words, comma-separated
//   LOAD_PROFILE          an existing folder to write one server CPU profile for each step to
//   LOAD_BASELINE         a copy of the repo to run the server from, to compare two versions
//   LOAD_SERVER_FLAGS     extra Node.js flags for the server process
import { fork } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const modes = ['livething', 'livething-sse', 'ws', 'socket.io', 'socket.io-polling'];
const mode = process.argv[2] ?? 'livething';
if (!modes.includes(mode)) throw new Error(`Unknown mode ${mode}. Use ${modes.join(', ')}.`);

const connectionCount = Number(process.argv[3] ?? 5000);
// The small-room steps put every connection in a room of 10.
if (connectionCount % 10 !== 0) throw new Error('Use a connection count that is a multiple of 10.');
// LOAD_PRESENCE=off turns presence off on the rooms, so a LiveThing join tells nobody.
const waitForPresence = mode.startsWith('livething') && process.env.LOAD_PRESENCE !== 'off';
// LOAD_BINARY_SIZES="1024,65536" sets the sizes of the binary steps, in bytes. "" skips them.
const binarySizes = (process.env.LOAD_BINARY_SIZES ?? '1024,65536')
  .split(',')
  .filter(Boolean)
  .map(Number);

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

const profileDir = process.env.LOAD_PROFILE;
const onlySteps = process.env.LOAD_STEPS?.split(',').filter(Boolean);

const counts = new Map();
let wake = noop;

function noop() {}

function bump(name, by = 1) {
  counts.set(name, (counts.get(name) ?? 0) + by);
  wake();
}

function count(name) {
  return counts.get(name) ?? 0;
}

function waitFor(condition, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      wake = noop;
      reject(new Error(`Timed out: ${label} (${JSON.stringify(Object.fromEntries(counts))})`));
    }, 120_000);
    wake = () => {
      if (!condition()) return;

      clearTimeout(timer);
      wake = noop;
      resolve();
    };
    wake();
  });
}

// ---- LiveThing frames, which the plain `ws` server speaks too ----

const FRAME_NAMES = { __connected__: 'connected', __subscribeOk__: 'joined' };

function countText(text) {
  if (text === 'ping' || text === 'pong') return;

  const event = text.slice(2, text.indexOf('"', 2));
  bump(FRAME_NAMES[event] ?? event);
  if (event === '__memberChanges__') {
    for (const change of JSON.parse(text)[1].changes) bump(`member ${change.kind}`);
  }
}

// A binary message: "ltbf", version 1, the envelope's length, the JSON envelope, the bytes.
function countBinary(data) {
  const envelope = data.toString('utf8', 9, 9 + data.readUInt32BE(5));
  bump(envelope.slice(2, envelope.indexOf('"', 2)));
}

function binaryFrame(envelope, bytes) {
  const json = Buffer.from(JSON.stringify(envelope));
  const header = Buffer.from([0x6c, 0x74, 0x62, 0x66, 1, 0, 0, 0, 0]);
  header.writeUInt32BE(json.length, 5);
  return Buffer.concat([header, json, bytes]);
}

function channel(room) {
  return { channel: { name: room, family: 'rooms' } };
}

/** The steps' actions as LiveThing frames, on any client that can send a frame. */
function frameActions(send, close) {
  let requestId = 0;
  return {
    echo: () => send(JSON.stringify(['echo', { text: 'hello there' }, null])),
    request: () =>
      send(
        JSON.stringify([
          'get-profile',
          null,
          { exchange: { id: `r${requestId++}`, source: 'client' } },
        ]),
      ),
    join: (room) => send(JSON.stringify(['__subscribe__', null, channel(room)])),
    sendMessage: (room, text) => send(JSON.stringify(['send-message', { text }, channel(room)])),
    uploadAvatar: (frame) => send(frame),
    shareScreenFrame: (frame) => send(frame),
    avatarFrame: (bytes) => binaryFrame(['upload-avatar', null, null], bytes),
    screenFrame: (room, bytes) => binaryFrame(['share-screen-frame', null, channel(room)], bytes),
    close,
  };
}

function openWebSocketClient(index) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/huddle?user=u${index}`, ['livething-v1'], {
      perMessageDeflate: false,
    });
    socket.on('message', (data, isBinary) =>
      isBinary ? countBinary(data) : countText(data.toString()),
    );
    socket.once('message', () =>
      resolve(
        frameActions(
          (data) => socket.send(data),
          () =>
            new Promise((closed) => {
              socket.once('close', closed);
              socket.close(1000);
            }),
        ),
      ),
    );
    socket.once('error', reject);
  });
}

// ---- LiveThing over server-sent events, the way the LiveThing client speaks it ----

const streamAgent = new http.Agent({ keepAlive: false, maxSockets: Infinity });

/**
 * The operating system queues only so many connections that the server has not accepted yet
 * (128 on macOS), and a client past that gets ECONNRESET. In the first step after connect,
 * every client opens its first POST connection at once. So this agent opens at most 100 new
 * connections that have not heard from the server yet. A finished TCP handshake does not mean
 * the server accepted the connection, so a slot frees on the first bytes back.
 */
class PacedAgent extends http.Agent {
  createConnection(options, done) {
    takeOpenSlot(() => {
      const socket = net.createConnection(options);
      const release = once(giveOpenSlot);
      // A long-poll GET can wait a long time for its first bytes, so it frees its slot sooner.
      socket.once(options.method === 'GET' ? 'connect' : 'data', release);
      socket.once('close', release);
      done(null, socket);
    });
  }
}

const MAX_OPENING = 100;
let opening = 0;
const waitingToOpen = [];

function takeOpenSlot(open) {
  if (opening < MAX_OPENING) {
    opening++;
    open();
  } else {
    waitingToOpen.push(open);
  }
}

function giveOpenSlot() {
  const next = waitingToOpen.shift();
  if (next) next();
  else opening--;
}

function once(fn) {
  let called = false;
  return () => {
    if (called) return;

    called = true;
    fn();
  };
}

// It keeps every idle connection. With the default of 256, the other clients would all open a
// new connection at the start of the next step.
const postAgent = new PacedAgent({
  keepAlive: true,
  maxSockets: Infinity,
  maxFreeSockets: Infinity,
});
const MAX_BATCH_FRAMES = 255;
const FRAME_HEADER_BYTES = 5;

/** A binary frame on the stream is "b" and the whole frame in base64. Decode only its envelope. */
function countBase64Binary(text) {
  const header = Buffer.from(text.slice(1, 13), 'base64');
  const needed = Math.ceil((9 + header.readUInt32BE(5)) / 3) * 4;
  countBinary(Buffer.from(text.slice(1, 1 + needed), 'base64'));
}

function openSseClient(index) {
  return new Promise((resolve, reject) => {
    const path = `/huddle?user=u${index}`;
    let secret;
    let maxPostBytes;
    let ended;
    const streamEnded = new Promise((done) => (ended = done));

    const lanes = { data: { queue: [], busy: false }, control: { queue: [], busy: false } };

    function post(lane, frames) {
      const body = Buffer.allocUnsafe(
        frames.reduce((size, frame) => size + FRAME_HEADER_BYTES + frame.bytes.length, 0),
      );
      let offset = 0;
      for (const frame of frames) {
        body[offset] = frame.binary ? 1 : 0;
        body.writeUInt32BE(frame.bytes.length, offset + 1);
        frame.bytes.copy(body, offset + FRAME_HEADER_BYTES);
        offset += FRAME_HEADER_BYTES + frame.bytes.length;
      }

      return new Promise((done, fail) => {
        const request = http.request(
          {
            method: 'POST',
            host: '127.0.0.1',
            port,
            path,
            agent: postAgent,
            headers: {
              'LiveThing-Secret': secret,
              'LiveThing-Lane': lane,
              'Content-Type': 'application/octet-stream',
              'Content-Length': body.length,
            },
          },
          (response) => {
            const chunks = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () =>
              done({ status: response.statusCode, body: Buffer.concat(chunks).toString() }),
            );
          },
        );
        request.on('error', fail);
        request.end(body);
      });
    }

    // One POST in flight on each lane. Frames that come while it is in flight go in the next one.
    async function pump(name) {
      const lane = lanes[name];
      if (lane.busy || lane.queue.length === 0) return;

      let taken = 0;
      let size = 0;
      while (taken < lane.queue.length && taken < (lane.room ?? MAX_BATCH_FRAMES)) {
        const next = lane.queue[taken].bytes.length + FRAME_HEADER_BYTES;
        if (size + next > maxPostBytes) {
          if (taken === 0) throw new Error(`A frame of ${next} bytes is over maxPostBytes.`);

          break;
        }

        size += next;
        taken++;
      }

      lane.busy = true;
      const answer = await post(name, lane.queue.slice(0, taken));
      lane.busy = false;
      if (answer.status === 204) {
        lane.queue.splice(0, taken);
        lane.room = undefined;
        void pump(name);
      } else if (answer.status === 503) {
        const { room, retryAfterMs } = JSON.parse(answer.body);
        lane.room = room > 0 ? room : 1;
        setTimeout(() => void pump(name), retryAfterMs ?? 250);
      } else if (answer.status !== 404 && answer.status !== 410) {
        throw new Error(`A POST got ${answer.status}: ${answer.body}`);
      }
    }

    function send(lane, data) {
      const binary = typeof data !== 'string';
      lanes[lane].queue.push({ binary, bytes: binary ? data : Buffer.from(data) });
      void pump(lane);
    }

    function onData(text) {
      if (text === 'ping') {
        send('control', 'pong');
      } else if (text.startsWith('b')) {
        countBase64Binary(text);
      } else {
        if (secret === undefined && text.startsWith('["__connected__"')) {
          ({ secret, maxPostBytes } = JSON.parse(text)[1]);
          resolve(
            frameActions(
              (data) => send('data', data),
              () => {
                send('control', JSON.stringify(['__close__', { code: 1000, reason: '' }, null]));
                return streamEnded;
              },
            ),
          );
        }

        countText(text);
      }
    }

    const request = http.get(
      {
        host: '127.0.0.1',
        port,
        path,
        agent: streamAgent,
        headers: { Accept: 'text/event-stream', 'LiveThing-Protocol': 'livething-v1' },
      },
      (response) => {
        if (response.statusCode !== 200) {
          reject(new Error(`The stream got ${response.statusCode}`));
          return;
        }

        response.setEncoding('utf8');
        let buffer = '';
        response.on('data', (chunk) => {
          buffer += chunk;
          let start = 0;
          let end;
          while ((end = buffer.indexOf('\n\n', start)) !== -1) {
            for (const line of buffer.slice(start, end).split('\n')) {
              if (line.startsWith('data: ')) onData(line.slice(6));
            }

            start = end + 2;
          }

          buffer = buffer.slice(start);
        });
        response.on('close', ended);
      },
    );
    request.on('error', reject);
  });
}

// ---- Socket.IO ----

const { io } = mode.startsWith('socket.io') ? await import('socket.io-client') : {};

function openSocketIoClient(index) {
  return new Promise((resolve, reject) => {
    const socket = io(`http://127.0.0.1:${port}`, {
      transports: [mode === 'socket.io' ? 'websocket' : 'polling'],
      query: { user: `u${index}` },
      // In Node, the polling client opens a new TCP connection for every request unless it
      // gets an agent. Browsers reuse connections, and so does the SSE client above.
      agent: postAgent,
      reconnection: false,
      forceNew: true,
    });
    for (const event of ['echoed', 'message', 'avatar-preview', 'screen-frame']) {
      socket.on(event, () => bump(event));
    }

    socket.on('disconnect', (reason) => bump(`disconnect: ${reason}`));

    socket.once('connected', () => {
      bump('connected');
      resolve({
        echo: () => socket.emit('echo', { text: 'hello there' }),
        request: () => socket.emit('get-profile', null, () => bump('get-profile')),
        join: (room) => socket.emit('join', room, () => bump('joined')),
        sendMessage: (room, text) => socket.emit('send-message', room, { text }),
        uploadAvatar: (bytes) => socket.emit('upload-avatar', bytes),
        shareScreenFrame: (frame) => socket.emit('share-screen-frame', frame.room, frame.bytes),
        avatarFrame: (bytes) => bytes,
        screenFrame: (room, bytes) => ({ room, bytes }),
        close: () =>
          new Promise((closed) => {
            socket.once('disconnect', closed);
            socket.disconnect();
          }),
      });
    });
    socket.once('connect_error', reject);
  });
}

const openClient = {
  livething: openWebSocketClient,
  ws: openWebSocketClient,
  'livething-sse': openSseClient,
  'socket.io': openSocketIoClient,
  'socket.io-polling': openSocketIoClient,
}[mode];

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
  await waitFor(() => count('connected') >= n, 'connected');

  return clients;
}

// ---- The steps ----

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

  const cpuUs =
    after.cpu.user + after.cpu.system - (before.cpuAfterGc.user + before.cpuAfterGc.system);
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

function sizeLabel(bytes) {
  return bytes >= 1024 ? `${bytes / 1024} KiB` : `${bytes} B`;
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
  counts.clear();
  for (const client of clients) for (let i = 0; i < echoesEach; i++) client.echo();
  await waitFor(() => count('echoed') >= connectionCount * echoesEach, 'echo');
});

await step('request', { units: connectionCount * echoesEach, unit: 'request' }, async () => {
  counts.clear();
  for (const client of clients) for (let i = 0; i < echoesEach; i++) client.request();
  await waitFor(() => count('get-profile') >= connectionCount * echoesEach, 'request');
});

// A small message is sent 10 times by each client, a large one once, so each step moves a
// similar amount of data.
function sendsFor(size) {
  return size <= 4096 ? 10 : 1;
}

for (const size of binarySizes) {
  const each = sendsFor(size);
  await step(
    `binary echo ${sizeLabel(size)}`,
    { units: connectionCount * each, unit: 'message' },
    async () => {
      counts.clear();
      const bytes = Buffer.alloc(size, 7);
      for (const client of clients) {
        const frame = client.avatarFrame(bytes);
        for (let i = 0; i < each; i++) client.uploadAvatar(frame);
      }

      await waitFor(() => count('avatar-preview') >= connectionCount * each, 'binary echo');
    },
  );
}

const roomSize = 10;
const roomCount = connectionCount / roomSize;
await step(
  `join ${roomCount} rooms of ${roomSize}`,
  { units: connectionCount, unit: 'join' },
  async () => {
    counts.clear();
    clients.forEach((client, index) => client.join(`room:small${index % roomCount}`));
    await waitFor(() => count('joined') >= connectionCount, 'small join');
    if (waitForPresence) {
      const pairs = roomCount * ((roomSize * (roomSize - 1)) / 2);
      await waitFor(() => count('member online') >= pairs, 'small join presence');
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
    counts.clear();
    clients.forEach((client, index) => {
      for (let i = 0; i < smallSends; i++) {
        client.sendMessage(`room:small${index % roomCount}`, 'hi all');
      }
    });
    await waitFor(() => count('message') >= smallDeliveries, 'small send');
  },
);

// LOAD_BIG_ROOMS="" skips these joins (they are slow on purpose) and the fan-outs that use them.
const bigRooms = (process.env.LOAD_BIG_ROOMS ?? '500,1000,2000')
  .split(',')
  .filter(Boolean)
  .map(Number)
  .filter((size) => size <= connectionCount);
for (const size of bigRooms) {
  await step(`join one room of ${size}`, { units: size, unit: 'join' }, async () => {
    counts.clear();
    for (let i = 0; i < size; i++) clients[i].join(`room:big${size}`);
    await waitFor(() => count('joined') >= size, 'big join');
    if (waitForPresence) {
      await waitFor(() => count('member online') >= (size * (size - 1)) / 2, 'big join presence');
    }
  });
}

const fanOutSize = bigRooms.at(-1);
if (fanOutSize) {
  const fanOutRoom = `room:big${fanOutSize}`;
  const senders = Math.min(20, fanOutSize);
  const sendsEach = 10;
  const fanOutDeliveries = senders * sendsEach * (fanOutSize - 1);
  await step(
    `fan-out to ${fanOutSize}`,
    { units: fanOutDeliveries, unit: 'delivery' },
    async () => {
      counts.clear();
      for (let s = 0; s < senders; s++) {
        for (let i = 0; i < sendsEach; i++) clients[s].sendMessage(fanOutRoom, 'hello room');
      }

      await waitFor(() => count('message') >= fanOutDeliveries, 'fan-out');
    },
  );

  for (const size of binarySizes) {
    // 100 small frames, or 2 large ones, so each step moves a similar amount of data.
    const sends = size <= 4096 ? 100 : 2;
    const binarySenders = Math.min(senders, sends);
    const deliveries = sends * (fanOutSize - 1);
    await step(
      `binary fan-out ${sizeLabel(size)} to ${fanOutSize}`,
      { units: deliveries, unit: 'delivery' },
      async () => {
        counts.clear();
        const bytes = Buffer.alloc(size, 7);
        for (let i = 0; i < sends; i++) {
          const client = clients[i % binarySenders];
          client.shareScreenFrame(client.screenFrame(fanOutRoom, bytes));
        }

        await waitFor(() => count('screen-frame') >= deliveries, 'binary fan-out');
      },
    );
  }
}

await step('disconnect', { units: connectionCount, unit: 'connection' }, async () => {
  await Promise.all(clients.map((client) => client.close()));
  // The server's close handlers run after the client sees the close.
  await new Promise((resolve) => setTimeout(resolve, 500));
});

const end = await serverStats();
console.log(
  JSON.stringify({
    mode,
    connections: connectionCount,
    heapLeftAfterCloseMB: Number(
      ((end.memory.heapUsed - baseline.memory.heapUsed) / 2 ** 20).toFixed(1),
    ),
    results,
  }),
);
serverProcess.send('exit');
await new Promise((resolve) => serverProcess.once('exit', resolve));
// A pipe to stdout can still be writing the report, so exit once it is out.
process.stdout.write('', () => process.exit(0));
