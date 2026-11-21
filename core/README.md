# @livething/core

The shared core of [LiveThing](https://livething.dev), a typed, WebSocket-first realtime framework for TypeScript. Both `@livething/client` and `@livething/server` are built on it.

It holds what both sides must agree on:

- **Typed errors:** `LiveThingError`, the `error()` factory and `.matches()`. An error you throw on the server is the same error you check on the client.
- **Built-in errors** that LiveThing raises, such as `RateLimited` and `StreamAborted`.
- **Close codes:** `CloseCodes`, names for the numbers that say why a connection closed.
- **Wire types and helpers** for the [wire protocol](https://livething.dev/core/learn/wire-protocol): plain JSON over WebSocket or HTTP.

It has no client or server code and uses nothing that only one platform has, so it runs in the browser, in Node.js and on Cloudflare.

## Install

It is a peer dependency of the client and the server, so you install it next to them:

```bash
npm install @livething/client @livething/core
```

## Example

```typescript
import { error } from '@livething/core';
import * as v from 'valibot';

// One definition, imported by the server (to throw) and the client (to match).
export const RoomFull = error('room-full', v.object({ roomId: v.string() }));
```

## Docs

- [Core overview](https://livething.dev/core/core/overview)
- [Error model](https://livething.dev/core/core/error-model)
- [Close codes](https://livething.dev/core/core/close-codes)

LiveThing is in alpha: its API can change in any release.

## License

MIT
