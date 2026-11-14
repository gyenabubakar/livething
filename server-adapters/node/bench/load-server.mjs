// The server half of the load benchmark. `load.mjs` forks it, so its CPU time and memory are
// the server's alone. Run with `--expose-gc`.
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { Session } from 'node:inspector/promises';
import { setup } from '@livething/server-node';
import { sse, websocket } from '@livething/server/adapters';
import { WebSocketServer } from 'ws';
import { buildHuddleDefinition } from './huddle-definition.mjs';

const mode = process.argv[2] ?? 'livething';
// sse() needs keepalive(), which a WebSocket-only run leaves out.
const overSse = process.env.LOAD_TRANSPORT === 'sse';

function listen(httpServer) {
  return new Promise((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => resolve(httpServer.address().port));
  });
}

async function startLiveThing() {
  const livething = setup();
  const huddleEndpoint = livething.bind(buildHuddleDefinition({ keepalivePings: overSse }), {
    transports: overSse ? [websocket(), sse()] : [websocket()],
    logger: { debug() {}, info() {}, warn() {}, error: console.error },
  });
  const httpServer = createServer((request, response) => huddleEndpoint.handle(request, response));
  httpServer.on('upgrade', huddleEndpoint.upgrade);
  await huddleEndpoint.ready();

  return listen(httpServer);
}

// The same app on plain `ws`, with no framework: the floor LiveThing is measured against.
async function startPlainWs() {
  const httpServer = createServer();
  const webSocketServer = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  const rooms = new Map();

  httpServer.on('upgrade', (request, socket, head) => {
    webSocketServer.handleUpgrade(request, socket, head, (ws) => {
      const userId = new URL(request.url, 'http://x').searchParams.get('user');
      const joined = new Set();
      ws.send(JSON.stringify(['__connected__', {}, null]));
      ws.on('message', (data) => {
        const [event, payload, metadata] = JSON.parse(data.toString());
        if (event === 'echo') {
          ws.send(JSON.stringify(['echoed', payload, null]));
        } else if (event === '__subscribe__') {
          const name = metadata.channel.name;
          let members = rooms.get(name);
          if (!members) rooms.set(name, (members = new Set()));

          members.add(ws);
          joined.add(members);
          ws.send(JSON.stringify(['__subscribeOk__', {}, metadata]));
        } else if (event === 'send-message') {
          const frame = JSON.stringify([
            'message',
            { text: payload.text, from: userId },
            { channel: metadata.channel },
          ]);
          for (const member of rooms.get(metadata.channel.name) ?? []) {
            if (member !== ws) member.send(frame);
          }
        } else if (event === 'get-profile') {
          ws.send(JSON.stringify(['get-profile', { userId }, metadata]));
        }
      });
      ws.on('close', () => {
        for (const members of joined) members.delete(ws);
      });
    });
  });

  return listen(httpServer);
}

const port = mode === 'ws' ? await startPlainWs() : await startLiveThing();

const inspector = new Session();
inspector.connect();

process.on('message', async (message) => {
  if (message === 'exit') process.exit(0);

  if (message === 'stats') {
    globalThis.gc?.();
    globalThis.gc?.();
    process.send({ cpu: process.cpuUsage(), memory: process.memoryUsage() });
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
