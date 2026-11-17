// The Huddle server that the middlebox lane reaches through each proxy. One TLS port speaks
// HTTP/2 and HTTP/1.1, as a real site does, so each proxy picks what it can: HTTP/2 goes to
// `handleStream`, HTTP/1.1 and WebSocket to `handle` and `upgrade`. It also serves the test page
// and the built client, and counts the POSTs it gets, so a test can tell stream mode from batch
// mode.
import { readFileSync } from 'node:fs';
import { createServer as createHttp1Server } from 'node:http';
import { createServer as createHttp2Server } from 'node:http2';
import { extname, join, normalize } from 'node:path';
import { createServer as createTlsServer } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { http, setup, websocket } from '@livething/server-node';
import type { IncomingHttpHeaders } from 'node:http';
import { buildHuddleDefinition } from './huddle-definition.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const certs = join(here, '..', 'certs');
const clientDist = join(here, '..', '..', '..', 'client', 'dist');
const port = Number(process.env.LIVETHING_MIDDLEBOX_PORT ?? 8443);

const huddle = setup();
const huddleEndpoint = huddle.bind(buildHuddleDefinition(), {
  transports: [websocket(), http()],
  // Every proxy in the stack reaches the server under its own name.
  allowedOrigins: [
    'https://livething.test:8443',
    'https://livething.test:9443',
    'https://livething.test:9444',
    'https://livething.test:9445',
  ],
  logger: { info() {}, warn: console.warn, error: console.error },
});

const stats = {
  streamPosts: 0,
  batchPosts: 0,
  streamRequests: 0,
  httpVersions: {} as Record<string, number>,
};

const types: Record<string, string> = {
  '.js': 'text/javascript',
  '.html': 'text/html',
  '.map': 'application/json',
};

interface Answer {
  status: number;
  type?: string;
  body?: string | Buffer;
}

/** The test page, the client files and the stats, or `null` for a Huddle request. */
function answerFor(method: string, target: string): Answer | null {
  const { pathname } = new URL(target, 'https://livething.test');
  if (pathname === '/huddle') return null;

  if (pathname === '/stats') {
    return { status: 200, type: 'application/json', body: JSON.stringify(stats) };
  }

  if (pathname === '/stats/reset' && method === 'GET') {
    Object.assign(stats, { streamPosts: 0, batchPosts: 0, streamRequests: 0, httpVersions: {} });
    return { status: 204 };
  }

  let file = join(here, 'index.html');
  if (pathname.startsWith('/client/')) {
    file = normalize(join(clientDist, pathname.slice('/client/'.length)));
    if (!file.startsWith(clientDist)) return { status: 404 };
  } else if (pathname !== '/') {
    return { status: 404 };
  }

  try {
    return {
      status: 200,
      type: types[extname(file)] ?? 'application/octet-stream',
      body: readFileSync(file),
    };
  } catch {
    return { status: 404 };
  }
}

function count(version: string, method: string, headers: IncomingHttpHeaders): void {
  stats.httpVersions[version] = (stats.httpVersions[version] ?? 0) + 1;
  if (method === 'GET' && headers.accept === 'text/event-stream') stats.streamRequests++;

  if (method !== 'POST') return;

  if (headers['livething-upload'] === 'stream') stats.streamPosts++;
  else if (headers['livething-lane'] === 'data') stats.batchPosts++;
}

const http2App = createHttp2Server();
http2App.on('stream', (stream, headers) => {
  const method = headers[':method'] ?? 'GET';
  const answer = answerFor(method, headers[':path'] ?? '/');
  if (answer) {
    stream.respond({
      ':status': answer.status,
      ...(answer.type ? { 'content-type': answer.type } : {}),
    });
    stream.end(answer.body);
    return;
  }

  count('2.0', method, headers);
  huddleEndpoint.handleStream(stream, headers);
});

const http1App = createHttp1Server((request, response) => {
  const method = request.method ?? 'GET';
  const answer = answerFor(method, request.url ?? '/');
  if (answer) {
    response.writeHead(answer.status, answer.type ? { 'Content-Type': answer.type } : {});
    response.end(answer.body);
    return;
  }

  count(request.httpVersion, method, request.headers);
  huddleEndpoint.handle(request, response);
});
http1App.on('upgrade', huddleEndpoint.upgrade);

const tlsOptions = {
  key: readFileSync(join(certs, 'server.key')),
  cert: readFileSync(join(certs, 'server.crt')),
  ALPNProtocols: ['h2', 'http/1.1'],
};

const server = createTlsServer(tlsOptions, (socket) => {
  const app = socket.alpnProtocol === 'h2' ? http2App : http1App;
  app.emit('connection', socket);
});

await huddleEndpoint.ready();
// On every interface, not only 127.0.0.1: the proxies in Docker reach it through the host's
// address. So other machines on the network can reach it too, and its /stats, while it runs.
server.listen(port, '0.0.0.0', () => console.log(`middlebox server on ${port}`));

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void huddle.shutdown().finally(() => process.exit(0));
  });
}
