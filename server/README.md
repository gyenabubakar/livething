# @livething/server

**Typed realtime for TypeScript.** `@livething/server` is the server of [LiveThing](https://livething.dev), a WebSocket-first realtime framework. You declare your events, requests and channels once on the server, and the client gets the same types with no code generation and no schema copy.

- **One contract for both sides.** `InferClient<typeof server>` is the whole client API. Rename an event on the server, and the client code that uses it becomes a type error.
- **Every input is checked** with the schema library you already use: any [Standard Schema](https://standardschema.dev) validator, such as Zod, Valibot or ArkType. A bad payload never reaches your code.
- **Pay only for what you use.** Features are capabilities you list. A capability you leave out adds no code to your bundle.
- **The features realtime apps need:** events, requests both ways, rooms (channels), streams, replay of missed messages, an inbox, awareness and presence, binary messages, file uploads, scheduled tasks, rate limits, dedup and keepalive.
- **WebSocket first, with an HTTP fallback.** Where a network blocks WebSocket, the client moves to server-sent events and POSTs, and your code does not change.
- **Runs on Node.js and Cloudflare Durable Objects** through a small adapter. Your server code is the same on each.

## Install

Install the server with one platform adapter:

```bash
# Node.js
npm install @livething/server @livething/server-node @livething/core

# Cloudflare Durable Objects
npm install @livething/server @livething/server-cloudflare @livething/core
```

Use any [Standard Schema](https://standardschema.dev) validator for inputs, such as Zod, Valibot or ArkType. The example below uses Valibot.

## Example

A server that takes a new display name and tells every connected user:

```typescript
import { emits, server, t } from '@livething/server';
import * as v from 'valibot';
import type { InferClient } from '@livething/server';

const base = server({
  capabilities: [emits({ 'user-renamed': t<{ userId: string; name: string }>() })],
});

const handleRename = base.on('rename', {
  input: v.object({ name: v.string() }),
  run(ctx, input) {
    ctx.user.setMeta({ name: input.name });
    ctx.broadcast('user-renamed', { userId: ctx.user.id, name: input.name });
  },
});

export const huddle = base.assemble({ handlers: [handleRename] });

// The whole client contract, in one type.
export type HuddleSocket = InferClient<typeof huddle>;
```

Then run it with [`@livething/server-node`](https://www.npmjs.com/package/@livething/server-node) or [`@livething/server-cloudflare`](https://www.npmjs.com/package/@livething/server-cloudflare), and connect with [`@livething/client`](https://www.npmjs.com/package/@livething/client).

## Docs

- [Introduction](https://livething.dev/core/start/introduction)
- [Installation](https://livething.dev/core/start/installation)
- [Quickstart](https://livething.dev/core/start/quickstart)
- [The server](https://livething.dev/core/server/overview)
- [Capabilities](https://livething.dev/core/server/capabilities/overview)

LiveThing is in alpha: its API can change in any release.

## License

MIT
