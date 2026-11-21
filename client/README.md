# @livething/client

**A typed realtime client for TypeScript.** `@livething/client` is the client of [LiveThing](https://livething.dev), a WebSocket-first realtime framework. It takes its types from your LiveThing server, so every event, request and payload is checked by the compiler, with no code generation.

- **Typed from the server.** Import one type, `InferClient<typeof server>`, and `socket.on()`, `socket.send()` and every request are typed. A wrong event name or payload is a type error.
- **Small by default.** Features are primitives you pass in. A primitive you leave out is not on the socket and not in your bundle.
- **The features realtime apps need:** reconnection with backoff, an offline send buffer, requests both ways, rooms (channels), streams, replay of missed messages, an inbox, awareness, binary messages, file uploads and keepalive.
- **WebSocket first, with an HTTP fallback.** The `http()` transport uses server-sent events down and POSTs up, for networks that block WebSocket.
- **Reactive stores** for connection state and data, which work with React, Vue, Svelte and Solid.
- **Runs everywhere:** browsers, React Native, Node.js, Bun, Deno and Cloudflare Workers.

## Install

```bash
npm install @livething/client @livething/core
```

## Example

```typescript
import { client, connect, reconnection } from '@livething/client';
import type { HuddleSocket } from '../server/huddle-definition';

export const socket = client<HuddleSocket>()(connect('wss://example.com/huddle'), reconnection());

socket.connect();

// `data` is typed from the server's emits() declaration.
socket.on('status-changed', (data) => {
  console.log(`${data.userId} is now ${data.status}`);
});

// Checked against the input schema of the server's handler.
socket.send('set-status', { status: 'away' });
```

`HuddleSocket` is the type your server exports with `InferClient`. See [`@livething/server`](https://www.npmjs.com/package/@livething/server).

## Docs

- [Introduction](https://livething.dev/core/start/introduction)
- [Quickstart](https://livething.dev/core/start/quickstart)
- [The client](https://livething.dev/core/client/overview)

LiveThing is in alpha: its API can change in any release.

## License

MIT
