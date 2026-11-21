# @livething/server-node

Run a [LiveThing](https://livething.dev) realtime server on **Node.js**, on its own or next to **Express, Koa, Hono, Fastify or h3**. LiveThing is a typed, WebSocket-first realtime framework for TypeScript: you define your server once, and the client is typed from it.

- Works with `node:http` and any framework that gives you the HTTP server.
- Serves WebSocket and the HTTP fallback (server-sent events and POSTs) from the same endpoint.
- Keeps replay, inbox, scheduled tasks and other state in SQLite, on disk or in memory.
- `shutdown()` finishes the endpoint's pending work and closes its connections before your process exits.
- Needs Node.js 22 or newer.

## Install

```bash
npm install @livething/server @livething/server-node @livething/core
```

| Import                           | For                                              |
| -------------------------------- | ------------------------------------------------ |
| `@livething/server-node`         | `node:http`, Express, Koa and others             |
| `@livething/server-node/hono`    | Hono, with `hono` and `@hono/node-server`        |
| `@livething/server-node/fastify` | Fastify, with `fastify` and `@fastify/websocket` |
| `@livething/server-node/h3`      | h3 version 2, with `h3` and `crossws`            |
| `@livething/server-node/h3/v1`   | h3 version 1, with `h3` and `crossws`            |

It stores its data in SQLite through [better-sqlite3](https://github.com/WiseLibs/better-sqlite3), a native module. On most systems npm downloads a ready-made build of it. On others it builds during install, and then needs Python and a C++ compiler.

## Example

With Express:

```typescript
import { createServer } from 'node:http';
import { setup } from '@livething/server-node';
import express from 'express';
import { huddle } from './server/huddle-definition';

const app = express();
const httpServer = createServer(app);
const { bind, ready } = setup();
const huddleEndpoint = bind(huddle, { sql: './data/huddle.sqlite' });

httpServer.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname === '/huddle') {
    huddleEndpoint.upgrade(request, socket, head);
    return;
  }

  socket.destroy();
});

await ready();
httpServer.listen(3000);
```

`huddle` is your server definition, made with [`@livething/server`](https://www.npmjs.com/package/@livething/server).

## Docs

- [Node.js adapter](https://livething.dev/core/runtimes/adapters/node)
- [Quickstart](https://livething.dev/core/start/quickstart)

LiveThing is in alpha: its API can change in any release.

## License

MIT
