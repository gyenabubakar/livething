# Security best practices

wskit gives you a typed, validated message pipeline. It does not — and cannot —
make every choice on your behalf. This document covers the responsibilities the
framework hands to you and how to discharge them safely.

## Validate inputs strictly

Every event you accept from a client should declare a real schema:

```ts
import { event } from '@wskit/server';
import * as v from 'valibot';

const SendMessage = event(
  'send-message',
  v.object({
    text: v.pipe(v.string(), v.maxLength(500)),
    roomId: v.pipe(v.string(), v.uuid()),
  }),
);
```

Use Standard Schema (Valibot, Zod, ArkType, etc.) or a parse function. The
engine runs the validator before your handler is called and rejects malformed
payloads automatically with `_error: validation-failed`.

Do not skip the schema with `v.unknown()` or `(p) => p as ...` — that opts out
of runtime safety entirely. If a payload field is genuinely free-form, validate
its shape (`v.object({})`, `v.record(v.string(), v.unknown())`) so the boundary
stays a real check.

For typed errors, the same rule applies — the validator on `error('x', schema)`
is what `.matches()` uses to narrow on the client. A type-cast validator means
`.matches()` only checks the error code, and malformed details slip through.

## Treat broadcast and echo data as untrusted

When your handler echoes a client's payload back to other connections —
through `ctx.broadcast`, `ctx.send`, `ctx.sendTo`, `ctx.sendToConnection`, or
the channel/namespace equivalents — the receiving client gets data that
originated outside your trust boundary.

```ts
.incoming(SendMessage, async (ctx, payload) => {
  // ✓ payload.text passed schema validation, but it's still attacker-controlled
  ctx.broadcast('message', { text: payload.text, from: ctx.meta.userId });
});
```

If a client renders that `text` as HTML without escaping, you have an XSS
vulnerability — and wskit has no way to catch it because the data was valid by
the schema. Apply one of:

- **Strict schemas.** Constrain the shape so unsafe content can't slip through.
  For example, validate URLs with `v.url()` instead of `v.string()`, cap free
  text length, reject control characters.
- **Server-side normalization.** Strip or escape HTML, normalize whitespace,
  reject zero-width characters before broadcasting.
- **Client-side escaping.** Render text content as text, not HTML. Use
  framework-native escaping (React's default JSX, Svelte's `{value}`, etc.) and
  avoid `innerHTML` / `v-html` / `dangerouslySetInnerHTML` for user-supplied
  data.

The same principle applies to anything derived from `ctx.meta`. Identity fields
should be set in `.onUpgrade()` from a server-verified source (JWT signature,
session cookie). Never accept a `userId` from the client.

## Authenticate connections in `.onUpgrade()`

```ts
import { RejectUpgrade } from '@wskit/server/errors';
import { withLifecycle } from '@wskit/server/lifecycle';

withLifecycle(server('chat')).onUpgrade(async (req) => {
  const token = new URL(req.url).searchParams.get('token');
  const user = await validateToken(token); // verify signature + expiry
  if (!user) throw RejectUpgrade(4002, 'Invalid token');
  return { meta: { userId: user.id } };
});
```

`ctx.meta` is populated from the upgrade return. Once set, it can be trusted
by handlers — the client cannot modify it after upgrade. Reject with
`RejectUpgrade(code, reason)` to refuse the connection before any handler
runs.

## Authorize channel subscriptions

Channels track membership server-side, but membership itself isn't enough — a
client that knows a channel name can ask to subscribe. Use
`.onBeforeSubscribe()` to gate:

```ts
.channel(scope('rooms', /^room-.+$/), (ch) => ch
  .onBeforeSubscribe(async (ctx) => {
    const isMember = await ctx.sql
      .exec(
        'SELECT 1 FROM channel_members WHERE name = ? AND user_id = ?',
        ctx.channel.name, ctx.meta.userId,
      )
      .one();
    if (!isMember) throw Forbidden({ reason: 'Not a member' });
  })
);
```

Throwing inside `onBeforeSubscribe` rejects the subscription. The client gets
`_error` with the channel scope attached.

## Don't leak internal errors to clients

Errors not registered via `withErrors().errors(...)` are sent to clients as
`{ code: 'internal-error' }` — no message, no stack, no internals. This is
deliberate.

If you want to give the client more context for a specific failure, define a
typed error and throw it explicitly:

```ts
const QuotaExceeded = error('quota-exceeded', v.object({ limit: v.number() }));

withErrors(server('chat')).errors(QuotaExceeded);

// In a handler:
if (overLimit(ctx)) throw QuotaExceeded({ limit: 100 });
```

Anything else — uncaught database errors, programming mistakes, unexpected
nulls — collapses to `internal-error`. Use `.onError()` to log them
server-side.

## Use `CloseCodes` for protocol-level rejection

When the right answer is to close the connection rather than respond, prefer
the framework's typed close codes:

```ts
import { CloseCodes } from '@wskit/server/errors';

ctx.close(CloseCodes.AUTH_EXPIRED, 'Refresh your token');
ctx.close(CloseCodes.RATE_LIMITED, 'Slow down');
ctx.close(CloseCodes.BANNED, 'Account suspended');
```

The client's reconnection logic reads these codes — `CloseCodes.BANNED` should
not be retried, `CloseCodes.AUTH_EXPIRED` should refresh and reconnect, etc.

## Keep `_`-prefixed fields out of your payloads

Single-underscore fields (`_seq`, `_messageId`, `_channel`, `_correlationId`,
etc.) are reserved for the engine's wire protocol. The framework strips and
injects them automatically; you don't write them in app handlers. If you
accidentally include one, the engine rejects the message at compile time
(declared events) or at runtime (modules).

Module-owned fields use the double-underscore prefix (`__module-id:field`) to
stay out of the engine's namespace. If you're writing a module, follow that
convention.

## What wskit doesn't do for you

- **Rate limiting** — there is no built-in rate limiter today. Use `.intercept()`
  to gate per-connection or per-event throughput, or wait for the dedicated
  `withRateLimit` primitive (issue #7).
- **Per-message authorization beyond the schema** — `.intercept(eventName, ...)`
  is the right place for "this user can't send this event in this room".
- **Encrypted payloads** — wskit assumes the WebSocket transport (WSS) provides
  confidentiality. End-to-end encryption is out of scope.
- **Audit logging** — implement via `.onIncoming` / `.onOutgoing` hooks or a
  module if you need it.
