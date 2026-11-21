# @livething/server-cloudflare

Run a [LiveThing](https://livething.dev) realtime server on **Cloudflare Durable Objects**, with **WebSocket hibernation**. LiveThing is a typed, WebSocket-first realtime framework for TypeScript: you define your server once, and the client is typed from it.

- Turns your server definition into a Durable Object class in one line.
- Supports WebSocket hibernation. Set `hibernation: true` on your server, and Cloudflare removes a quiet Durable Object from memory while its WebSocket connections stay open.
- Keeps replay, inbox, scheduled tasks and other state in the Durable Object's own SQLite storage, and runs scheduled tasks on its alarm.
- Serves WebSocket and the HTTP fallback (server-sent events and POSTs). Only WebSocket connections get hibernation.

## Install

```bash
npm install @livething/server @livething/server-cloudflare @livething/core
```

It needs a `compatibility_date` of `2026-04-07` or later in `wrangler.jsonc`.

## Example

```typescript
import { bind } from '@livething/server-cloudflare';
import { huddle } from './server/huddle-definition';
import type { Env } from './env';

export class HuddleServer extends bind(huddle) {}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const room = new URL(request.url).searchParams.get('room') ?? 'default';
    const id = env.HUDDLE_SERVER.idFromName(room);
    return env.HUDDLE_SERVER.get(id).fetch(request);
  },
};
```

```jsonc
// wrangler.jsonc
{
  "compatibility_date": "2026-04-07",
  "compatibility_flags": ["nodejs_compat"],
  "durable_objects": {
    "bindings": [{ "name": "HUDDLE_SERVER", "class_name": "HuddleServer" }],
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["HuddleServer"] }],
}
```

`huddle` is your server definition, made with [`@livething/server`](https://www.npmjs.com/package/@livething/server). Use a class declaration (`export class ... extends bind(...)`), not `export const`, so `wrangler types` keeps the binding typed.

## Docs

- [Cloudflare adapter](https://livething.dev/core/runtimes/adapters/cloudflare)
- [Hibernation](https://livething.dev/core/server/server/hibernation)

LiveThing is in alpha: its API can change in any release.

## License

MIT
