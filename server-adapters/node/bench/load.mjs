// End-to-end load benchmark for the Node adapter. It forks the server (`load-server.mjs`), opens
// many real clients and reports the server's CPU time and memory for each step.
//
//   node bench/load.mjs [mode] [connections]
//
// Modes:
//   livething           LiveThing over WebSocket
//   livething-http      LiveThing over http() on HTTP/1.1: a server-sent events stream, and
//                       batch mode POSTs from the client
//   livething-http-h2   the same batch mode, over cleartext HTTP/2 (one connection a client)
//   livething-http-stream  http() stream mode over cleartext HTTP/2: one long POST a client
//   ws                  the same app on plain `ws`, to show what LiveThing adds
//   socket.io           the same app on Socket.IO over WebSocket
//   socket.io-polling   the same app on Socket.IO over HTTP long-polling, its fallback
//
// Environment variables:
//   LOAD_PRESENCE=off     turn presence off on LiveThing
//   LOAD_BINARY_SIZES     sizes of the binary steps in bytes (default 1024,65536; empty skips them)
//   LOAD_BIG_ROOMS        sizes of the one-room join steps (default 500,1000,2000; empty skips
//                         them). The fan-out steps use the biggest one.
//   LOAD_STEPS            measure only the steps whose names start with these words, comma-separated
//   LOAD_PROFILE          an existing folder to write one server CPU profile for each step to
//   LOAD_SERVER           the private IP of a server machine running `load-remote.mjs`, to run
//                         the clients on this machine and the server on that one
//   LOAD_CONTROL_PORT     the port `load-remote.mjs` listens on (default 9100)
//   LOAD_BASELINE         a copy of the repo to run the server from, to compare two versions
//   LOAD_SERVER_FLAGS     extra Node.js flags for the server process
//   LOAD_H2_ENTRY=stream  on the HTTP/2 modes, serve the raw streams with `handleStream`
//                         instead of a compatibility server with `handle`
//   LOAD_WARM=on          run every step twice in the same server and report only the second time
//   LOAD_SUITE=chat       run the chat app instead, which stores messages in a SQLite file: sends,
//                         history loads, a busy hour of mixed actions and a reconnect wave
//   LOAD_SUITE=features   LiveThing only: the chat app's direct messages with an inbox and read
//                         receipts, a search that streams its hits, and a delete the client
//                         confirms through a server request
//   LOAD_REPLAY=on        LiveThing chat only: record messages for replay, and catch up with it
//   LOAD_DEDUP=on         LiveThing chat only: list dedup(), which gives every message an ID. The
//                         LiveThing client sends no IDs of its own, so neither do these clients.
//   LOAD_RATE_LIMIT=on    LiveThing chat only: a rate limit of 600 actions a minute for each
//                         connection,
//                         which no client reaches, to measure the check
//   LOAD_MIX_RATE         actions a second in the chat's busy hour (default 2000)
//   LOAD_MIX_SECONDS      how long the busy hour lasts, in seconds (default 20)
import { fork } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import http from 'node:http';
import http2 from 'node:http2';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const modes = [
  'livething',
  'livething-http',
  'livething-http-h2',
  'livething-http-stream',
  'ws',
  'socket.io',
  'socket.io-polling',
];
const mode = process.argv[2] ?? 'livething';
if (!modes.includes(mode)) throw new Error(`Unknown mode ${mode}. Use ${modes.join(', ')}.`);

const suite = process.env.LOAD_SUITE ?? 'core';
if (!['core', 'chat', 'features'].includes(suite)) {
  throw new Error('LOAD_SUITE must be core, chat or features.');
}

if (suite === 'features' && !mode.startsWith('livething')) {
  throw new Error('LOAD_SUITE=features runs only on a LiveThing mode.');
}

const replay = process.env.LOAD_REPLAY === 'on';
for (const name of ['LOAD_REPLAY', 'LOAD_DEDUP', 'LOAD_RATE_LIMIT']) {
  if (process.env[name] === 'on' && (suite !== 'chat' || !mode.startsWith('livething'))) {
    throw new Error(`${name}=on runs only with LOAD_SUITE=chat on a LiveThing mode.`);
  }
}

const connectionCount = Number(process.argv[3] ?? 5000);
// The small-room steps put every connection in a room of 10.
if (!Number.isSafeInteger(connectionCount) || connectionCount <= 0 || connectionCount % 10 !== 0) {
  throw new Error('Use a positive connection count that is a multiple of 10.');
}

/** A comma-separated list of whole numbers, each at least `min`. "" is an empty list. */
function numberList(name, fallback, min) {
  const values = (process.env[name] ?? fallback).split(',').filter(Boolean).map(Number);
  if (values.some((value) => !Number.isSafeInteger(value) || value < min)) {
    throw new Error(`${name} must be whole numbers of at least ${min}, separated by commas.`);
  }

  return values;
}

// LOAD_PRESENCE=off turns presence off on the rooms, so a LiveThing join tells nobody.
const waitForPresence = mode.startsWith('livething') && process.env.LOAD_PRESENCE !== 'off';
// LOAD_BINARY_SIZES="1024,65536" sets the sizes of the binary steps, in bytes. "" skips them.
const binarySizes = numberList('LOAD_BINARY_SIZES', '1024,65536', 1);
// LOAD_BIG_ROOMS="" skips the big-room joins (they are slow on purpose) and the fan-outs that use
// them. A room of one has no one to deliver to, so its fan-out would divide by zero.
// Each size once, smallest first: a second join of a room a client is in gets no reply from
// LiveThing, and the fan-out uses the biggest room.
const bigRooms = [...new Set(numberList('LOAD_BIG_ROOMS', '500,1000,2000', 2))]
  .filter((size) => size <= connectionCount)
  .sort((a, b) => a - b);

// LOAD_BASELINE=<dir> runs the server from another copy of the packages (a `node_modules` in
// that folder), to compare a change with the build before it.
let serverScript = fileURLToPath(new URL('./load-server.mjs', import.meta.url));
if (process.env.LOAD_BASELINE) {
  const benchCopy = join(process.env.LOAD_BASELINE, 'bench');
  mkdirSync(benchCopy, { recursive: true });
  for (const file of [
    'load-server.mjs',
    'huddle-definition.mjs',
    'huddle-chat-definition.mjs',
    'chat-servers.mjs',
  ]) {
    copyFileSync(join(dirname(serverScript), file), join(benchCopy, file));
  }

  serverScript = join(benchCopy, 'load-server.mjs');
}

const serverFlags = process.env.LOAD_SERVER_FLAGS?.split(' ').filter(Boolean) ?? [];
// LOAD_SERVER=<private IP> runs the server on that machine, through `load-remote.mjs`.
const remote = process.env.LOAD_SERVER;
if (remote && (process.env.LOAD_BASELINE || process.env.LOAD_PROFILE || serverFlags.length)) {
  throw new Error(
    'LOAD_BASELINE, LOAD_PROFILE and LOAD_SERVER_FLAGS run only with a local server. Set ' +
      'LOAD_SERVER_FLAGS on the server machine instead, and leave the others out.',
  );
}

// `load-remote.mjs` stops a server that hears nothing for 5 minutes, and the busy hour asks for
// nothing while it runs.
if (remote && Number(process.env.LOAD_MIX_SECONDS ?? 20) > 240) {
  throw new Error('With LOAD_SERVER, keep LOAD_MIX_SECONDS at 240 or less.');
}

const serverHost = remote ?? '127.0.0.1';
const controlUrl = `http://${remote}:${process.env.LOAD_CONTROL_PORT ?? 9100}/`;

async function control(request) {
  const response = await fetch(controlUrl, { method: 'POST', body: JSON.stringify(request) });
  const answer = await response.json();
  if (!response.ok) throw new Error(`load-remote: ${answer.error}`);

  return answer;
}

let serverProcess = null;
let port;
if (remote) {
  // The server reads its settings from these variables, so they go to the other machine.
  const env = {};
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('LOAD_')) env[name] = process.env[name];
  }

  ({ port } = await control({ start: { mode, env } }));
} else {
  serverProcess = fork(serverScript, [mode], { execArgv: ['--expose-gc', ...serverFlags] });
  // A crash here must not leave the server running, or a caller waiting on it never ends.
  process.on('exit', () => serverProcess.kill());
  ({ port } = await new Promise((resolve) => serverProcess.once('message', resolve)));
}

function callServer(message) {
  if (remote) return control({ message });

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
if (onlySteps?.length === 0) {
  throw new Error('LOAD_STEPS is empty. Leave it out to measure every step.');
}

const matchedSteps = new Set();

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

// While the busy-hour step runs, each client keeps how long a message took to reach it and how
// long a history request took to answer, in milliseconds. All clients run in this one process,
// so the times they compare come from one clock.
let latencies = null;
const historyStarts = new Map();
let historyRequests = 0;
// The time a busy-hour action was planned for. A reply time counts from it, not from when the
// action ran, so a client that falls behind its plan does not hide the wait.
let plannedAt;
// How busy the clients' process was in the busy hour, in percent of one CPU core.
let clientCpuAtStart;
let clientCpuPercent;

// With LOAD_REPLAY=on, the highest delivery number each client has seen in its room, and how many
// messages it got, by client index, so the client can catch up from there after it reconnects.
const lastSeqs = [];
const messagesByClient = [];

function keepLastSeq(text, index) {
  const [, payload, metadata] = JSON.parse(text);
  const seq = metadata?.delivery?.seq ?? payload?.seq;
  if (seq > (lastSeqs[index] ?? 0)) lastSeqs[index] = seq;
}

function countText(text, index) {
  if (text === 'ping' || text === 'pong') return;

  const event = text.slice(2, text.indexOf('"', 2));
  if (replay && (event === 'message' || event === '__subscribeOk__')) keepLastSeq(text, index);
  if (replay && event === 'message') messagesByClient[index] = (messagesByClient[index] ?? 0) + 1;
  if (suite === 'features') answerFeatureFrame(text, index, event);
  // Last: a wait checks its condition on each bump, so what the frame changed must be in place.
  bump(FRAME_NAMES[event] ?? event);

  if (latencies && event === 'message') {
    latencies.message.push(performance.now() - Number(JSON.parse(text)[1].text));
  } else if (latencies && event === 'load-history') {
    historyAnswered(JSON.parse(text)[2].exchange.id);
  }

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

function historyAnswered(id) {
  const started = historyStarts.get(id);
  if (started === undefined) return;

  historyStarts.delete(id);
  latencies?.history.push(performance.now() - started);
}

/** A new history request ID, with its start time while the busy-hour step runs. */
function historyRequestId() {
  const id = `h${historyRequests++}`;
  if (latencies) historyStarts.set(id, plannedAt ?? performance.now());
  return id;
}

// LOAD_SUITE=features: each client's way to send a frame, by index, so it can answer a server
// request and acknowledge a direct message as the LiveThing client does.
const frameSenders = [];
const lastDmSeqs = [];
const ackedDmSeqs = [];
const sentDmIds = [];
// Frames to send once a reconnecting client is ready: the inbox can deliver before it is.
const waitingFrames = [];
let frameIds = 0;

function sendFrom(index, frame) {
  if (frameSenders[index]) frameSenders[index](frame);
  else (waitingFrames[index] ??= []).push(frame);
}

/** A direct message's channel: the two users of a pair, client 2k and client 2k + 1. */
function dmChannel(index) {
  const first = index - (index % 2);
  return { channel: { name: `dm:u${first}-u${first + 1}`, family: 'dms' } };
}

/** Answers what the server sends a client in the features suite. */
function answerFeatureFrame(text, index, event) {
  if (event === 'confirm-delete') {
    const [, , metadata] = JSON.parse(text);
    sendFrom(index, JSON.stringify(['confirm-delete', { confirmed: true }, metadata]));
  } else if (event === 'delete-message') {
    if (JSON.parse(text)[1].deleted) bump('deleted');
  } else if (event === 'send-message') {
    sentDmIds[index] ??= [];
    sentDmIds[index].push(JSON.parse(text)[1].id);
  } else if (event === 'message') {
    // As the LiveThing client does, tell the server once, after the messages that arrived together.
    const acking = lastDmSeqs[index] === ackedDmSeqs[index];
    lastDmSeqs[index] = JSON.parse(text)[2].delivery.seq;
    if (acking) {
      queueMicrotask(() => {
        ackedDmSeqs[index] = lastDmSeqs[index];
        const ack = { receivedThrough: lastDmSeqs[index] };
        sendFrom(index, JSON.stringify(['__received__', ack, dmChannel(index)]));
      });
    }
  }
}

/** The steps' actions as LiveThing frames, on any client that can send a frame. */
function frameActions(send, close, index) {
  frameSenders[index] = send;
  for (const frame of waitingFrames[index]?.splice(0) ?? []) send(frame);

  let requestId = 0;
  function request(event, payload, metadata) {
    const exchange = { id: `f${frameIds++}`, source: 'client' };
    send(JSON.stringify([event, payload, { ...metadata, exchange }]));
  }

  return {
    joinDm: () => send(JSON.stringify(['__subscribe__', null, dmChannel(index)])),
    leaveDm: () =>
      send(
        JSON.stringify([
          '__unsubscribe__',
          null,
          { channel: { ...dmChannel(index).channel, unsubscribeId: `leave-${index}` } },
        ]),
      ),
    sendDm: (text) => request('send-message', { text }, dmChannel(index)),
    readDms: () =>
      send(JSON.stringify(['__read__', { readThrough: lastDmSeqs[index] }, dmChannel(index)])),
    searchMessages: (query) =>
      send(JSON.stringify(['search-messages', { query }, { stream: { id: `s${frameIds++}` } }])),
    deleteMessage: () =>
      request('delete-message', { messageId: sentDmIds[index].shift(), preview: 'hello' }),
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
    react: (room, messageId) =>
      send(JSON.stringify(['react', { messageId, emoji: '+1' }, channel(room)])),
    startTyping: (room) => send(JSON.stringify(['start-typing', null, channel(room)])),
    catchUp: (room, lastKnownSeq) =>
      send(JSON.stringify(['__replay__', { lastKnownSeq }, channel(room)])),
    loadHistory: (room) =>
      send(
        JSON.stringify([
          'load-history',
          {},
          { ...channel(room), exchange: { id: historyRequestId(), source: 'client' } },
        ]),
      ),
    uploadAvatar: (frame) => send(frame),
    shareScreenFrame: (frame) => send(frame),
    avatarFrame: (bytes) => binaryFrame(['upload-avatar', null, null], bytes),
    screenFrame: (room, bytes) => binaryFrame(['share-screen-frame', null, channel(room)], bytes),
    close,
  };
}

function openWebSocketClient(index) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(
      `ws://${serverHost}:${port}/huddle?user=u${index}`,
      ['livething-v1'],
      {
        perMessageDeflate: false,
      },
    );
    socket.on('message', (data, isBinary) =>
      isBinary ? countBinary(data) : countText(data.toString(), index),
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
          index,
        ),
      ),
    );
    socket.once('error', reject);
  });
}

// ---- LiveThing over http(), the way the LiveThing client speaks it ----

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

const H2 = mode === 'livething-http-h2' || mode === 'livething-http-stream';
const STREAM = mode === 'livething-http-stream';
const PROBE_FRAME = 2;
const START_FRAME = 3;
const CLOSE_FRAME = 4;

function frameHeader(type, length) {
  const header = Buffer.allocUnsafe(FRAME_HEADER_BYTES);
  header[0] = type;
  header.writeUInt32BE(length, 1);
  return header;
}

/** Reads a response body to the end, and resolves with its status and text. */
function readAnswer(response, status) {
  return new Promise((done) => {
    const chunks = [];
    response.on('data', (chunk) => chunks.push(chunk));
    response.on('end', () => done({ status, body: Buffer.concat(chunks).toString() }));
  });
}

// Over HTTP/2, one connection for each client, as a browser keeps one for each site.
function openHttpClient(index) {
  return new Promise((resolve, reject) => {
    const path = `/huddle?user=u${index}`;
    let secret;
    let maxPostBytes;
    let ended;
    const streamEnded = new Promise((done) => (ended = done));

    const session = H2 ? http2.connect(`http://${serverHost}:${port}`) : null;
    session?.on('error', () => {});

    const lanes = {
      data: { queue: [], busy: false, confirmed: 0 },
      control: { queue: [], busy: false },
    };

    // Stream mode: one long POST. Frames written in one tick go in one write.
    let upload = null;
    let uploadQueue = [];
    let flushQueued = false;
    let probed;
    const probeAcked = new Promise((done) => (probed = done));

    function flushUpload() {
      flushQueued = false;
      const parts = [];
      for (const frame of uploadQueue) {
        parts.push(frameHeader(frame.binary ? 1 : 0, frame.bytes.length), frame.bytes);
      }

      uploadQueue = [];
      upload.write(Buffer.concat(parts));
    }

    function openUpload() {
      upload = session.request({
        ':method': 'POST',
        ':path': path,
        'LiveThing-Secret': secret,
        'LiveThing-Lane': 'data',
        'LiveThing-Upload': 'stream',
        'Content-Type': 'application/octet-stream',
      });
      upload.on('error', () => {});
      upload.resume();
      upload.write(frameHeader(PROBE_FRAME, 0));
    }

    function post(lane, frames, seq) {
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

      const headers = {
        'LiveThing-Secret': secret,
        'LiveThing-Lane': lane,
        'Content-Type': 'application/octet-stream',
        'Content-Length': body.length,
        ...(seq === undefined ? {} : { 'LiveThing-Seq': String(seq) }),
      };

      if (session) {
        return new Promise((done, fail) => {
          const request = session.request({ ':method': 'POST', ':path': path, ...headers });
          request.on('response', (head) => readAnswer(request, head[':status']).then(done));
          request.on('error', fail);
          request.end(body);
        });
      }

      return new Promise((done, fail) => {
        const request = http.request(
          { method: 'POST', host: serverHost, port, path, agent: postAgent, headers },
          (response) => readAnswer(response, response.statusCode).then(done),
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
      const seq = name === 'data' ? lane.confirmed + 1 : undefined;
      const answer = await post(name, lane.queue.slice(0, taken), seq);
      lane.busy = false;
      if (answer.status === 204) {
        lane.queue.splice(0, taken);
        if (name === 'data') lane.confirmed += taken;
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
      const frame = { binary, bytes: binary ? data : Buffer.from(data) };
      if (lane === 'data' && upload) {
        uploadQueue.push(frame);
        if (!flushQueued) {
          flushQueued = true;
          queueMicrotask(flushUpload);
        }

        return;
      }

      lanes[lane].queue.push(frame);
      void pump(lane);
    }

    async function ready() {
      if (STREAM) {
        openUpload();
        await probeAcked;
        upload.write(Buffer.concat([frameHeader(START_FRAME, 4), Buffer.from([0, 0, 0, 1])]));
      }

      resolve(
        frameActions(
          (data) => send('data', data),
          async () => {
            const close = Buffer.from(
              JSON.stringify(['__close__', { code: 1000, reason: '' }, null]),
            );
            if (upload) {
              // The close goes after the frames in the upload, and the server ends the stream.
              if (flushQueued) flushUpload();
              upload.end(Buffer.concat([frameHeader(CLOSE_FRAME, close.length), close]));
              await streamEnded;
              session.close();
              return;
            }

            send('control', close.toString());
            await streamEnded;
            session?.close();
          },
          index,
        ),
      );
    }

    function onData(text) {
      if (text === 'ping') {
        send('control', 'pong');
      } else if (text.startsWith('b')) {
        countBase64Binary(text);
      } else if (text.startsWith('["__ack__"')) {
        if (text.includes('"probe":true')) probed();
      } else {
        if (secret === undefined && text.startsWith('["__connected__"')) {
          ({ secret, maxPostBytes } = JSON.parse(text)[1]);
          void ready();
        }

        countText(text, index);
      }
    }

    const streamHeaders = { Accept: 'text/event-stream', 'LiveThing-Protocol': 'livething-v1' };
    function onStream(response, status) {
      if (status !== 200) {
        reject(new Error(`The stream got ${status}`));
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
    }

    if (session) {
      const request = session.request({ ':path': path, ...streamHeaders });
      request.on('response', (head) => onStream(request, head[':status']));
      request.on('error', reject);
    } else {
      const request = http.get(
        { host: serverHost, port, path, agent: streamAgent, headers: streamHeaders },
        (response) => onStream(response, response.statusCode),
      );
      request.on('error', reject);
    }
  });
}

// ---- Socket.IO ----

const { io } = mode.startsWith('socket.io') ? await import('socket.io-client') : {};

function openSocketIoClient(index) {
  return new Promise((resolve, reject) => {
    const socket = io(`http://${serverHost}:${port}`, {
      transports: [mode === 'socket.io' ? 'websocket' : 'polling'],
      query: { user: `u${index}` },
      // In Node, the polling client opens a new TCP connection for every request unless it
      // gets an agent. Browsers reuse connections, and so does the http() client above.
      agent: postAgent,
      reconnection: false,
      forceNew: true,
    });
    for (const event of ['echoed', 'avatar-preview', 'screen-frame', 'reaction', 'typing']) {
      socket.on(event, () => bump(event));
    }

    socket.on('message', (message) => {
      bump('message');
      if (latencies) latencies.message.push(performance.now() - Number(message.text));
    });

    socket.on('disconnect', (reason) => bump(`disconnect: ${reason}`));

    socket.once('connected', () => {
      bump('connected');
      resolve({
        echo: () => socket.emit('echo', { text: 'hello there' }),
        request: () => socket.emit('get-profile', null, () => bump('get-profile')),
        join: (room) => socket.emit('join', room, () => bump('joined')),
        sendMessage: (room, text) => socket.emit('send-message', room, { text }),
        react: (room, messageId) => socket.emit('react', room, { messageId, emoji: '+1' }),
        startTyping: (room) => socket.emit('start-typing', room),
        loadHistory: (room) => {
          const id = historyRequestId();
          socket.emit('load-history', room, {}, () => {
            bump('load-history');
            historyAnswered(id);
          });
        },
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
  'livething-http': openHttpClient,
  'livething-http-h2': openHttpClient,
  'livething-http-stream': openHttpClient,
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

// LOAD_WARM=on runs every step twice in the same server and reports only the second time. V8
// compiles a server's code on other threads while it warms up, and the server's CPU time counts
// those threads, so the first time a step runs it measures some of that compiling too.
const warm = process.env.LOAD_WARM === 'on';
let warming = false;

async function step(name, measure, run) {
  if (warming) {
    await run();
    return undefined;
  }

  const { units, unit: unitLabel } = measure;

  const prefixes = onlySteps?.filter((wanted) => name.startsWith(wanted)) ?? [];
  for (const prefix of prefixes) matchedSteps.add(prefix);
  const measured = !onlySteps || prefixes.length > 0;

  const before = await serverStats();
  if (measured && profileDir) await callServer('profile-start');
  const started = performance.now();
  await run();

  const wallMs = performance.now() - started;
  // Read the stats first, so the CPU of writing the profile is not counted in the step.
  const after = await serverStats();
  if (measured && profileDir) {
    await callServer({ profileTo: `${profileDir}/${name.replaceAll(' ', '-')}.cpuprofile` });
  }

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

const roomSize = 10;
const roomCount = connectionCount / roomSize;

function smallRoom(index) {
  return `room:small${index % roomCount}`;
}

async function joinSmallRooms(clients) {
  await step(
    `join ${roomCount} rooms of ${roomSize}`,
    { units: connectionCount, unit: 'join' },
    async () => {
      counts.clear();
      clients.forEach((client, index) => client.join(smallRoom(index)));
      await waitFor(() => count('joined') >= connectionCount, 'small join');
      if (waitForPresence) {
        const pairs = roomCount * ((roomSize * (roomSize - 1)) / 2);
        await waitFor(() => count('member online') >= pairs, 'small join presence');
      }
    },
  );
}

async function connectStep(baseline) {
  let clients;
  const connect = await step(
    'connect',
    { units: connectionCount, unit: 'connection' },
    async () => {
      clients = await openClients(connectionCount);
    },
  );
  const connectRow = results.find((row) => row.step === 'connect');
  if (connectRow) {
    connectRow.heapBytesPerConnection = Math.round(
      (connect.after.memory.heapUsed - baseline.memory.heapUsed) / connectionCount,
    );
  }

  return clients;
}

async function disconnectStep(clients) {
  await step('disconnect', { units: connectionCount, unit: 'connection' }, async () => {
    await Promise.all(clients.map((client) => client.close()));
    // The server's close handlers run after the client sees the close.
    await new Promise((resolve) => setTimeout(resolve, 500));
  });
}

/** A seeded random number generator (mulberry32), so every server gets the same busy hour. */
function seededRandom(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function percentile(values, p) {
  if (values.length === 0) return null;

  const sorted = values.toSorted((a, b) => a - b);
  return Number(sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)].toFixed(1));
}

// LOAD_MIX_RATE actions a second, for LOAD_MIX_SECONDS, in the busy-hour step.
const mixRate = numberList('LOAD_MIX_RATE', '2000', 1)[0];
const mixSeconds = numberList('LOAD_MIX_SECONDS', '20', 1)[0];
// A client sends about 20 frames outside the busy hour. Over the limit, the server would drop
// frames and the run would only time out.
if (
  process.env.LOAD_RATE_LIMIT === 'on' &&
  (mixRate * Math.min(mixSeconds, 60)) / connectionCount + 20 > 600
) {
  throw new Error(
    'With LOAD_RATE_LIMIT=on, a client would send more than its 600 actions a minute. Use more ' +
      'connections, a lower LOAD_MIX_RATE or fewer LOAD_MIX_SECONDS.',
  );
}

// Out of 100 actions in the busy hour: what a person in a team chat does most, typing, then
// sending, reacting, and scrolling back through the history.
// `event` is what the action's answer is called, and `answers` how many it gets: a send reaches
// the room minus its sender.
const MIX = [
  { action: 'startTyping', share: 40, event: 'typing', answers: roomSize - 1 },
  { action: 'sendMessage', share: 30, event: 'message', answers: roomSize - 1 },
  { action: 'react', share: 15, event: 'reaction', answers: roomSize - 1 },
  { action: 'loadHistory', share: 15, event: 'load-history', answers: 1 },
];

/** One action of the busy hour, planned for `at`: a message's text is that time. */
function act(client, planned, at) {
  const { action } = planned.kind;
  const room = smallRoom(planned.client);
  plannedAt = at;
  if (action === 'sendMessage') {
    client.sendMessage(room, String(at));
  } else if (action === 'react') {
    client.react(room, `m${planned.at}`);
  } else {
    client[action](room);
  }

  plannedAt = undefined;
}

/** The chat app with its SQLite store: sends, history, a busy hour and a reconnect wave. */
async function runChatSteps() {
  counts.clear();
  const baseline = await serverStats();
  const clients = await connectStep(baseline);
  await joinSmallRooms(clients);

  // A broadcast from a handler skips its sender, so each send reaches the room minus one.
  const sendsEach = 5;
  await step(
    `send and store in rooms of ${roomSize}`,
    { units: connectionCount * sendsEach, unit: 'message' },
    async () => {
      counts.clear();
      clients.forEach((client, index) => {
        for (let i = 0; i < sendsEach; i++) client.sendMessage(smallRoom(index), '0');
      });
      const deliveries = connectionCount * sendsEach * (roomSize - 1);
      await waitFor(() => count('message') >= deliveries, 'send and store');
    },
  );

  const loadsEach = 5;
  await step(
    'load 50 messages of history',
    { units: connectionCount * loadsEach, unit: 'request' },
    async () => {
      counts.clear();
      clients.forEach((client, index) => {
        for (let i = 0; i < loadsEach; i++) client.loadHistory(smallRoom(index));
      });
      await waitFor(() => count('load-history') >= connectionCount * loadsEach, 'history');
    },
  );

  const random = seededRandom(1);
  const expected = new Map(MIX.map((kind) => [kind.event, 0]));
  const actions = Array.from({ length: mixRate * mixSeconds }, () => {
    let pick = random() * 100;
    const kind = MIX.find((option) => (pick -= option.share) < 0);
    expected.set(kind.event, expected.get(kind.event) + kind.answers);

    return {
      at: random() * mixSeconds * 1000,
      kind,
      client: Math.floor(random() * connectionCount),
    };
  }).sort((a, b) => a.at - b.at);

  const busyName = `busy hour, ${mixRate} actions a second`;
  await step(busyName, { units: actions.length, unit: 'action' }, async () => {
    counts.clear();
    latencies = { message: [], history: [] };
    const started = performance.now();
    clientCpuAtStart = process.cpuUsage();

    let next = 0;
    await new Promise((resolve) => {
      const timer = setInterval(() => {
        const now = performance.now() - started;
        while (next < actions.length && actions[next].at <= now) {
          const planned = actions[next++];
          act(clients[planned.client], planned, started + planned.at);
        }

        if (next === actions.length) {
          clearInterval(timer);
          resolve();
        }
      }, 2);
    });

    await waitFor(() => [...expected].every((entry) => count(entry[0]) >= entry[1]), 'busy hour');
    const clientCpu = process.cpuUsage(clientCpuAtStart);
    clientCpuPercent = Math.round(
      (clientCpu.user + clientCpu.system) / 10 / (performance.now() - started),
    );
  });

  const busyRow = results.find((row) => row.step === busyName);
  if (busyRow) {
    const replyTimes = {
      // Every client runs in this one process. Near 100, the clients wait for their own thread,
      // and the reply times measure them as much as the server.
      clientCpuPercent,
      messageP50Ms: percentile(latencies.message, 50),
      messageP99Ms: percentile(latencies.message, 99),
      historyP50Ms: percentile(latencies.history, 50),
      historyP99Ms: percentile(latencies.history, 99),
    };

    Object.assign(busyRow, replyTimes);
    console.error(JSON.stringify({ step: busyName, ...replyTimes }));
    if (clientCpuPercent >= 90) {
      console.error(
        `The clients used ${clientCpuPercent}% of a CPU core in the busy hour, so their reply ` +
          'times include their own waiting. The server CPU numbers still hold. Use fewer clients ' +
          'or a lower LOAD_MIX_RATE for reply times.',
      );
    }
  }

  latencies = null;
  historyStarts.clear();

  // One client in each room loses its connection at once, as when a building's Wi-Fi drops. While
  // it is away, every other member of its room sends a message. Then it connects again, joins its
  // room again and gets what it missed: with replay, the server sends the missed messages, and
  // without it, the client loads the room's history.
  const wave = roomCount;
  await Promise.all(clients.slice(0, wave).map((client) => client.close()));
  counts.clear();
  for (let index = wave; index < connectionCount; index++) {
    clients[index].sendMessage(smallRoom(index), '0');
  }

  const sentWhileAway = (connectionCount - wave) * (roomSize - 2);
  await waitFor(() => count('message') >= sentWhileAway, 'sends while away');
  // A rejoin's `__subscribeOk__` moves the cursor past the missed messages, so keep it first.
  const cursors = lastSeqs.slice(0, wave);

  await step(`reconnect ${wave} clients`, { units: wave, unit: 'reconnect' }, async () => {
    counts.clear();
    messagesByClient.length = 0;
    const reopened = await openClients(wave);
    reopened.forEach((client, index) => {
      clients[index] = client;
      client.join(smallRoom(index));
      if (replay) client.catchUp(smallRoom(index), cursors[index]);
      else client.loadHistory(smallRoom(index));
    });

    // Catch-up can send a few more: a client never gets its own broadcast live, so when its own
    // message was the room's last one, its cursor is before it and replay sends it back too.
    const caughtUp = replay
      ? () => cursors.every((_, index) => (messagesByClient[index] ?? 0) >= roomSize - 1)
      : () => count('load-history') >= wave;
    await waitFor(() => count('joined') >= wave && caughtUp(), 'reconnect');
    if (waitForPresence) {
      await waitFor(() => count('member online') >= wave * (roomSize - 1), 'reconnect presence');
    }
  });

  await disconnectStep(clients);

  return baseline;
}

/**
 * LiveThing's own features on the chat app: direct messages with an inbox and read receipts, a
 * search that streams its hits, and a delete that asks the client to confirm. Client 2k and client
 * 2k + 1 share a direct message. Each step ends when the last client heard back, and a client's
 * frames are handled in order, so a reply proves the server handled every frame before it.
 */
async function runFeatureSteps() {
  counts.clear();
  const baseline = await serverStats();
  const clients = await connectStep(baseline);
  const dmsEach = 5;
  const half = connectionCount / 2;

  await step('join a direct message', { units: connectionCount, unit: 'join' }, async () => {
    counts.clear();
    for (const client of clients) client.joinDm();
    await waitFor(() => count('joined') >= connectionCount, 'direct message join');
    // The second of each pair to join tells the first one.
    await waitFor(() => count('member online') >= half, 'direct message presence');
  });

  // Each read goes to both people in the direct message, so a client hears its own read once the
  // server handled every acknowledgement it sent before it. Like Huddle's, the inbox tells no one
  // about an acknowledgement (`broadcastReceipts` is off), so the step has no `__received__` frames.
  await step(
    'direct message to an online member, acknowledged and read',
    { units: connectionCount * dmsEach, unit: 'message' },
    async () => {
      counts.clear();
      for (const client of clients) for (let i = 0; i < dmsEach; i++) client.sendDm('hello');
      await waitFor(
        () => count('send-message') >= connectionCount * dmsEach,
        'direct messages stored',
      );
      await waitFor(() => count('message') >= connectionCount * dmsEach, 'direct messages');

      for (const client of clients) client.readDms();
      await waitFor(() => count('__read__') >= connectionCount * 2, 'reads');
    },
  );

  // The odd clients are away, so the inbox keeps each message for them. Their partners hear it
  // before the step starts, so the step measures none of the leaving.
  counts.clear();
  await Promise.all(
    clients.map((client, index) => {
      if (index % 2 === 0) return undefined;

      frameSenders[index] = null;
      return client.close();
    }),
  );
  await waitFor(() => count('member offline') >= half, 'partners away');

  await step(
    'direct message to a member who is away',
    { units: half * dmsEach, unit: 'message' },
    async () => {
      counts.clear();
      clients.forEach((client, index) => {
        if (index % 2 === 0) for (let i = 0; i < dmsEach; i++) client.sendDm('hello again');
      });
      await waitFor(() => count('send-message') >= half * dmsEach, 'direct messages stored');
    },
  );

  await step('reconnect and get the inbox', { units: half, unit: 'reconnect' }, async () => {
    counts.clear();
    await Promise.all(
      clients.map(async (_, index) => {
        if (index % 2 === 1) clients[index] = await openClient(index);
      }),
    );
    await waitFor(() => count('message') >= half * dmsEach, 'inbox');
    clients.forEach((client, index) => index % 2 === 1 && client.readDms());
    await waitFor(() => count('__read__') >= connectionCount, 'reads');
  });

  await step(
    'search that streams 20 hits',
    { units: connectionCount, unit: 'search' },
    async () => {
      counts.clear();
      for (const client of clients) client.searchMessages('hello');
      await waitFor(() => count('__streamEnd__') >= connectionCount, 'searches');
      if (count('search-messages') < connectionCount * 20) {
        throw new Error(`A search found fewer than 20 hits: ${count('search-messages')} in all.`);
      }
    },
  );

  await step(
    'delete confirmed with a server request',
    { units: connectionCount, unit: 'delete' },
    async () => {
      counts.clear();
      for (const client of clients) client.deleteMessage();
      await waitFor(() => count('delete-message') >= connectionCount, 'deletes');
      if (count('deleted') < connectionCount) {
        throw new Error('A confirmed delete deleted nothing.');
      }
    },
  );

  // Leave the direct messages, so a second pass with LOAD_WARM=on joins them again.
  counts.clear();
  for (const client of clients) client.leaveDm();
  await waitFor(() => count('__unsubscribeOk__') >= connectionCount, 'direct message leave');
  await disconnectStep(clients);

  return baseline;
}

/** Run every step once, from the first connection to the last disconnect. */
async function runCoreSteps() {
  counts.clear();
  const baseline = await serverStats();
  const clients = await connectStep(baseline);

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

  await joinSmallRooms(clients);

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

  await disconnectStep(clients);

  return baseline;
}

const runSteps = { core: runCoreSteps, chat: runChatSteps, features: runFeatureSteps }[suite];

if (warm) {
  warming = true;
  await runSteps();
  warming = false;
}

const baseline = await runSteps();

const unmatched = onlySteps?.filter((prefix) => !matchedSteps.has(prefix)) ?? [];
if (unmatched.length > 0) throw new Error(`LOAD_STEPS names no step: ${unmatched.join(', ')}`);

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
if (remote) {
  await control({ message: 'exit' });
} else {
  serverProcess.send('exit');
  await new Promise((resolve) => serverProcess.once('exit', resolve));
}

// A pipe to stdout can still be writing the report, so exit once it is out.
process.stdout.write('', () => process.exit(0));
