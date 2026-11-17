// The server half of the load benchmark. `load.mjs` forks it, so its CPU time and memory are
// the server's alone. Run with `--expose-gc`.
//
// Modes: `livething` (WebSocket), `livething-http` (http() over HTTP/1.1), `livething-http-h2`
// and `livething-http-stream` (http() over cleartext HTTP/2), `ws` (the same app on plain `ws`),
// `socket.io` (WebSocket) and `socket.io-polling` (HTTP long-polling).
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createH2cServer } from 'node:http2';
import { Session } from 'node:inspector/promises';
import { setup } from '@livething/server-node';
import { http } from '@livething/server/adapters';
import { WebSocketServer } from 'ws';
import { buildHuddleDefinition } from './huddle-definition.mjs';

const mode = process.argv[2] ?? 'livething';
const presence = process.env.LOAD_PRESENCE !== 'off';
// `load-remote.mjs` sets it to the server machine's private IP, so clients on another machine can
// connect.
const host = process.env.LOAD_HOST ?? '127.0.0.1';
// `load-remote.mjs` sets a fixed port, so the firewall between the machines opens only that one.
const listenPort = Number(process.env.LOAD_PORT ?? 0);
// LOAD_SUITE=chat serves the chat app, which stores its messages in a SQLite file, and
// LOAD_SUITE=features the same app with direct messages, a search stream and a confirmed delete.
// Their files load only then, so a LOAD_BASELINE build without them still runs the core suite.
const features = process.env.LOAD_SUITE === 'features';
const chat =
  process.env.LOAD_SUITE === 'chat' || features
    ? {
        ...(await import('./chat-servers.mjs')),
        ...(await import('./huddle-chat-definition.mjs')),
      }
    : undefined;
const chatDatabase = chat?.openChatDatabase({ search: features });

function listen(httpServer) {
  // Node closes an idle keep-alive connection after 5 seconds. The pauses between steps are
  // longer, so every POST and poll would then open a new connection at once, more than the
  // operating system queues. Production servers behind a load balancer keep idle connections
  // for about a minute too.
  httpServer.keepAliveTimeout = 65_000;
  return new Promise((resolve) => {
    httpServer.listen(listenPort, host, () => resolve(httpServer.address().port));
  });
}

/** `transport`: 'websocket', 'http' (HTTP/1.1) or 'http-h2' (cleartext HTTP/2). */
async function startLiveThing(transport) {
  const livething = setup();
  const overHttp = transport !== 'websocket';

  const build = chat ? chat.buildHuddleChatDefinition : buildHuddleDefinition;
  const definition = build({
    presence,
    keepalive: overHttp,
    replay: process.env.LOAD_REPLAY === 'on',
    dedup: process.env.LOAD_DEDUP === 'on',
    rateLimit: process.env.LOAD_RATE_LIMIT === 'on',
    features,
  });
  const huddleEndpoint = livething.bind(definition, {
    ...(overHttp ? { transports: [http()] } : {}),
    ...(chatDatabase ? { sql: chatDatabase } : {}),
    logger: { debug() {}, info() {}, warn() {}, error: console.error },
  });
  function handler(request, response) {
    return huddleEndpoint.handle(request, response);
  }

  if (transport === 'http-h2') {
    // LOAD_H2_ENTRY=stream serves the raw streams, so Node makes no compatibility objects.
    const raw = process.env.LOAD_H2_ENTRY === 'stream';
    const h2Server = createH2cServer(
      { settings: { maxConcurrentStreams: 1000 } },
      raw ? undefined : handler,
    );
    if (raw) h2Server.on('stream', huddleEndpoint.handleStream);
    await huddleEndpoint.ready();
    return new Promise((resolve) => {
      h2Server.listen(listenPort, host, () => resolve(h2Server.address().port));
    });
  }

  const httpServer = createServer(handler);
  httpServer.on('upgrade', huddleEndpoint.upgrade);
  await huddleEndpoint.ready();

  return listen(httpServer);
}

// A binary message: "ltbf", version 1, the envelope's length, the JSON envelope, the bytes.
function readBinaryFrame(data) {
  const length = data.readUInt32BE(5);
  return {
    envelope: JSON.parse(data.toString('utf8', 9, 9 + length)),
    bytes: data.subarray(9 + length),
  };
}

function binaryFrame(envelope, bytes) {
  const json = Buffer.from(JSON.stringify(envelope));
  const header = Buffer.from([0x6c, 0x74, 0x62, 0x66, 1, 0, 0, 0, 0]);
  header.writeUInt32BE(json.length, 5);
  return Buffer.concat([header, json, bytes]);
}

// The same app on plain `ws`, with no framework: the floor LiveThing is measured against.
async function startPlainWs() {
  const httpServer = createServer();
  const webSocketServer = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  const rooms = new Map();

  function broadcast(name, sender, frame) {
    for (const member of rooms.get(name) ?? []) {
      if (member !== sender) member.send(frame);
    }
  }

  httpServer.on('upgrade', (request, socket, head) => {
    webSocketServer.handleUpgrade(request, socket, head, (ws) => {
      const userId = new URL(request.url, 'http://x').searchParams.get('user');
      const joined = new Set();
      ws.send(JSON.stringify(['__connected__', {}, null]));
      ws.on('message', (data, isBinary) => {
        if (isBinary) {
          const { envelope, bytes } = readBinaryFrame(data);
          const [event, , metadata] = envelope;
          if (event === 'upload-avatar') {
            ws.send(binaryFrame(['avatar-preview', null, null], bytes));
          } else if (event === 'share-screen-frame') {
            const routing = { channel: metadata.channel };
            const frame = binaryFrame(['screen-frame', { from: userId }, routing], bytes);
            broadcast(metadata.channel.name, ws, frame);
          }

          return;
        }

        const [event, payload, metadata] = JSON.parse(data.toString());
        if (event === 'echo') {
          ws.send(JSON.stringify(['echoed', payload, null]));
        } else if (event === '__subscribe__') {
          const name = metadata.channel.name;
          let members = rooms.get(name);
          if (!members) rooms.set(name, (members = new Set()));

          members.add(ws);
          joined.add(name);
          ws.send(JSON.stringify(['__subscribeOk__', {}, metadata]));
        } else if (event === 'send-message') {
          const frame = JSON.stringify([
            'message',
            { text: payload.text, from: userId },
            { channel: metadata.channel },
          ]);
          broadcast(metadata.channel.name, ws, frame);
        } else if (event === 'get-profile') {
          ws.send(JSON.stringify(['get-profile', { userId }, metadata]));
        }
      });
      ws.on('close', () => {
        for (const name of joined) {
          const members = rooms.get(name);
          members.delete(ws);
          if (members.size === 0) rooms.delete(name);
        }
      });
    });
  });

  return listen(httpServer);
}

// The same app on Socket.IO. Socket.IO has no server-sent events: when WebSocket is blocked, it
// falls back to HTTP long-polling, so that is the transport its fallback run uses.
async function startSocketIo(transport) {
  const { Server } = await import('socket.io');
  const httpServer = createServer();
  const io = new Server(httpServer, {
    transports: [transport],
    perMessageDeflate: false,
    httpCompression: false,
    serveClient: false,
  });

  io.on('connection', (socket) => {
    const userId = socket.handshake.query.user;
    socket.emit('connected', {});

    socket.on('echo', (payload) => socket.emit('echoed', payload));
    socket.on('get-profile', (_payload, reply) => reply({ userId }));
    socket.on('join', (room, reply) => {
      socket.join(room);
      reply({});
    });
    socket.on('send-message', (room, payload) => {
      socket.to(room).emit('message', { text: payload.text, from: userId });
    });
    socket.on('upload-avatar', (bytes) => socket.emit('avatar-preview', bytes));

    socket.on('share-screen-frame', (room, bytes) => {
      socket.to(room).emit('screen-frame', { from: userId }, bytes);
    });
  });

  return listen(httpServer);
}

const starters = {
  livething: () => startLiveThing('websocket'),
  'livething-http': () => startLiveThing('http'),
  'livething-http-h2': () => startLiveThing('http-h2'),
  'livething-http-stream': () => startLiveThing('http-h2'),
  ws: chat ? () => chat.startPlainWsChat(chatDatabase, listen) : startPlainWs,
  'socket.io': () =>
    chat ? chat.startSocketIoChat(chatDatabase, listen, 'websocket') : startSocketIo('websocket'),
  'socket.io-polling': () =>
    chat ? chat.startSocketIoChat(chatDatabase, listen, 'polling') : startSocketIo('polling'),
};

if (!starters[mode]) {
  throw new Error(`Unknown mode ${mode}. Use ${Object.keys(starters).join(', ')}.`);
}

const port = await starters[mode]();

const inspector = new Session();
inspector.connect();

// `load.mjs` and `load-remote.mjs` stop a server with SIGTERM, so the 'exit' handlers still run.
process.once('SIGTERM', () => process.exit(0));
process.on('message', async (message) => {
  if (message === 'exit') process.exit(0);

  if (message === 'stats') {
    // The forced GC makes the memory numbers stable. A step starts after it (`cpuAfterGc`) and
    // ends before the next one (`cpu`), so its CPU time does not include it.
    const cpu = process.cpuUsage();
    globalThis.gc?.();
    globalThis.gc?.();
    process.send({ cpu, cpuAfterGc: process.cpuUsage(), memory: process.memoryUsage() });
  } else if (message === 'profile-start') {
    await inspector.post('Profiler.enable');
    await inspector.post('Profiler.setSamplingInterval', { interval: 100 });
    await inspector.post('Profiler.start');
    process.send('profiling');
  } else if (message.profileTo) {
    const { profile } = await inspector.post('Profiler.stop');
    writeFileSync(message.profileTo, JSON.stringify(profile));
    process.send('profiled');
  }
});

process.send({ port });
