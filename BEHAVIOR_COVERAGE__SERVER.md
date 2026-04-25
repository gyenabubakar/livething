# wskit Server - Behavior Coverage

Last updated: 2026-04-25

## How to read this

- This is a feature-to-tests map for the current server stack across `core`, `server`, `server-adapters/cloudflare`, and `tests-e2e/cloudflare`.
- `Unit / integrated` means source-adjacent Vitest coverage under the package that owns the behavior.
- `E2E` means the real Cloudflare worker/WebSocket coverage under [tests-e2e/cloudflare/tests](./tests-e2e/cloudflare/tests/).
- Feature lists are behavior-oriented, not a raw dump of every assertion. When multiple files prove the same surface, all relevant files are linked.
- If a feature has no `E2E` subsection, it currently has source-level coverage only.

## Coverage map

### 1. Core error model (`@wskit/core`)

What it covers:

- shared close-code constants
- `WskitError`
- `error(...)` factories with code-only, parser-based, and Standard Schema validation
- built-in `Block` and `ValidationFailed`

#### Unit / integrated

- close-code catalog is exposed and frozen - [core/src/errors.spec.ts](./core/src/errors.spec.ts)
- `WskitError` carries `code`, `detail`, `name`, `message`, and stack metadata - [core/src/errors.spec.ts](./core/src/errors.spec.ts)
- `error(...)` supports code-only definitions and typed factories with `matches()` guards - [core/src/errors.spec.ts](./core/src/errors.spec.ts)
- parser-backed and schema-backed errors validate runtime detail before constructing `WskitError` - [core/src/errors.spec.ts](./core/src/errors.spec.ts)
- `Block` and `ValidationFailed` keep their intended runtime identity and match semantics - [core/src/errors.spec.ts](./core/src/errors.spec.ts)
- type-layer fixtures verify `error()` overload narrowing (code-only `ErrorDef` is not callable, parser/schema factories are callable, `matches()` narrows correctly), `CloseCodes` immutability, and the `ValidationFailed` factory shape - [core/src/errors.test.ts](./core/src/errors.test.ts)

### 2. Server factory, builder composition, and typing (`@wskit/server`, `@wskit/server/full`)

What it covers:

- `server(name)`
- `server` from `@wskit/server/full`
- `event(...)`
- group composition, duplicate detection, feature accumulation, and client inference

#### Unit / integrated

- `event(...)` builds the named contract used by incoming, outgoing, request, and stream features - [server/src/\_builder/server-builder.spec.ts](./server/src/_builder/server-builder.spec.ts), [server/src/incoming/incoming.spec.ts](./server/src/incoming/incoming.spec.ts), [server/src/outgoing/outgoing.spec.ts](./server/src/outgoing/outgoing.spec.ts)
- the base builder returns a frozen `ServerDefinition`, preserves declaration order, and rejects duplicate identities - [server/src/\_builder/server-builder.spec.ts](./server/src/_builder/server-builder.spec.ts), [server/src/\_builder/integration.spec.ts](./server/src/_builder/integration.spec.ts)
- `@wskit/server/full` exposes the full feature surface without manual `with*` wrappers - [server/src/\_builder/server-builder.spec.ts](./server/src/_builder/server-builder.spec.ts), [server/src/\_builder/integration.spec.ts](./server/src/_builder/integration.spec.ts)
- callback-style and multi-file `group(...)` composition inline correctly and preserve parent state - [server/src/\_builder/server-builder.spec.ts](./server/src/_builder/server-builder.spec.ts), [server/src/\_builder/integration.spec.ts](./server/src/_builder/integration.spec.ts)
- env typing, meta typing, scoped outgoing visibility, `ctx.ack()` availability, `ctx.nudges()`, and `InferClient` contracts are exercised end-to-end at the type layer - [server/src/\_builder/integration.spec.ts](./server/src/_builder/integration.spec.ts), [server/src/\_builder/integration.test.ts](./server/src/_builder/integration.test.ts)
- the public API surface for each feature entry point is type-checked to confirm exported symbols are accessible and internal primitives are hidden - [server/src/public-api.test-d.ts](./server/src/public-api.test-d.ts)

### 3. Lifecycle hooks and connection/runtime engine

What it covers:

- `onInit`, `onUpgrade`, `onConnect`, `onDisconnect`, `onShutdown`, `onBinary`, `onError`, `onValidationError`
- connection bootstrap, connection teardown, dispatch retries, ping/pong protocol branches, and hibernation wake plumbing

#### Unit / integrated

- lifecycle hooks register correctly, chain together, reject duplicates, and preserve builder typing - [server/src/lifecycle/with.spec.ts](./server/src/lifecycle/with.spec.ts)
- connection startup waits for async connect work before processing frames - [server/src/\_engine/runtime/connection.spec.ts](./server/src/_engine/runtime/connection.spec.ts)
- upgrade decisions cover normal accept, explicit reject, empty-hook pass-through, and internal-error fallback - [server/src/\_engine/runtime/behaviors.spec.ts](./server/src/_engine/runtime/behaviors.spec.ts)
- retry control flow for `Defer`, `Disconnect`, `Block`, invalid JSON, protocol pings, stream cancel, and async `onAfterSend` rejection logging is covered in the dispatch engine - [server/src/\_engine/runtime/behaviors.spec.ts](./server/src/_engine/runtime/behaviors.spec.ts), [server/src/\_engine/runtime/messages.spec.ts](./server/src/_engine/runtime/messages.spec.ts)
- failed `_subscribe` and `_unsubscribe` frames each route through `handleRuntimeError` with the originating channel routing metadata (`_channel`, `_channelScope`), so `onError` sees which channel triggered the failure - [server/src/\_engine/runtime/behaviors.spec.ts](./server/src/_engine/runtime/behaviors.spec.ts)
- hibernation wake restores serialized `channelMemberships` when present, deliberately leaves memberships empty when the attachment uses the legacy `channels` array format (migration safety), reports orphaned streams via per-id `_error` frames, and runtime shutdown runs module shutdown hooks - [server/src/\_engine/runtime/behaviors.spec.ts](./server/src/_engine/runtime/behaviors.spec.ts), [server/src/\_engine/runtime/connection.spec.ts](./server/src/_engine/runtime/connection.spec.ts)
- the `InitContext` passed to `onInit` is type-constrained: it exposes `sql`, `kv`, `env`, `log`, and `platform`, and explicitly does not expose connection-level APIs like `send`, `broadcast`, `id`, `close`, or `schedule` - [server/src/context.test-d.ts](./server/src/context.test-d.ts)

#### E2E

- `onConnect`, `onDisconnect`, `onShutdown`, `onUpgrade`, `onValidationError`, async lifecycle waiting, and `onError` catching handler-thrown errors are exercised against a live Cloudflare worker, including shutdown with no connected clients and upgrade-attached `meta` / `tags` - [tests-e2e/cloudflare/tests/lifecycle-hooks.spec.ts](./tests-e2e/cloudflare/tests/lifecycle-hooks.spec.ts)
- binary-frame lifecycle coverage proves per-frame `onBinary` invocation, `ctx.meta` access, `sendBinary` self-delivery, and `broadcastBinary` fan-out with and without `excludeSelf` on the wire - [tests-e2e/cloudflare/tests/binary.spec.ts](./tests-e2e/cloudflare/tests/binary.spec.ts)
- raw text and JSON ping/pong protocol handling works without dedicated handlers - [tests-e2e/cloudflare/tests/protocol-pings.spec.ts](./tests-e2e/cloudflare/tests/protocol-pings.spec.ts)

### 4. Incoming events

What it covers:

- `incoming(...)`
- event validation
- async handler sequencing
- silent drops for unknown or malformed events

#### Unit / integrated

- incoming primitives carry repeatable identity keyed by event name and preserve optional validators from parse functions or Standard Schema objects - [server/src/incoming/incoming.spec.ts](./server/src/incoming/incoming.spec.ts)
- compile-time duplicate detection and handler payload typing are covered at the builder layer - [server/src/\_builder/server-builder.spec.ts](./server/src/_builder/server-builder.spec.ts), [server/src/\_builder/integration.test.ts](./server/src/_builder/integration.test.ts)

#### E2E

- matching incoming events dispatch to handlers on a real socket - [tests-e2e/cloudflare/tests/incoming.spec.ts](./tests-e2e/cloudflare/tests/incoming.spec.ts)
- invalid payloads are rejected before handler execution - [tests-e2e/cloudflare/tests/incoming.spec.ts](./tests-e2e/cloudflare/tests/incoming.spec.ts)
- async handlers are awaited before the next frame is processed - [tests-e2e/cloudflare/tests/incoming.spec.ts](./tests-e2e/cloudflare/tests/incoming.spec.ts)
- unknown events and frames without `event` are safely dropped - [tests-e2e/cloudflare/tests/incoming.spec.ts](./tests-e2e/cloudflare/tests/incoming.spec.ts)

### 5. Outgoing send pipeline and connection context helpers

What it covers:

- `outgoing(...)`
- `ctx.send`, `ctx.broadcast`, `ctx.sendTo`, `ctx.sendToConnection`, `ctx.close`
- `ctx.meta`, `ctx.tags`, `ctx.channels`, `ctx.quality`, SQL, KV, and task-context send helpers

#### Unit / integrated

- outgoing contracts are keyed by event name and enforced by the runtime pipeline - [server/src/outgoing/outgoing.spec.ts](./server/src/outgoing/outgoing.spec.ts), [server/src/outgoing/runtime.spec.ts](./server/src/outgoing/runtime.spec.ts)
- the send pipeline rejects array/primitive payloads, reserved-key collisions, and undeclared events, including scoped namespace/channel routing rules - [server/src/outgoing/runtime.spec.ts](./server/src/outgoing/runtime.spec.ts)
- connection and task context helpers cover `sendToConnection`, `broadcast`, `broadcastBinary`, `waitUntil`, `setAlarm`, `ctx.channels.members()`, `ctx.channel.send`, `cancelScheduled` no-match logging (both connection and task contexts), attachment serialization shape (`channelMemberships` replaces the legacy `channels` list, plus `activeStreamIds` so wake can detect orphaned streams), context-extender precedence, and logger forwarding - [server/src/\_engine/contexts/contexts.spec.ts](./server/src/_engine/contexts/contexts.spec.ts)

#### E2E

- `ctx.sendTo`, `ctx.sendToConnection`, `ctx.broadcast`, and `ctx.close` behave correctly on live connections, including `excludeSelf` and unknown-target delivery status - [tests-e2e/cloudflare/tests/ctx-send.spec.ts](./tests-e2e/cloudflare/tests/ctx-send.spec.ts)
- metadata attached during upgrade remains available during later handling and across peer delivery - [tests-e2e/cloudflare/tests/ctx-meta.spec.ts](./tests-e2e/cloudflare/tests/ctx-meta.spec.ts)
- tag management and connection lookup APIs cover self-tagging, multi-tag persistence, no-op untag behavior, `getConnections()`, `getConnectionsByTag()`, and live connection counts across one or many connections - [tests-e2e/cloudflare/tests/ctx-tags.spec.ts](./tests-e2e/cloudflare/tests/ctx-tags.spec.ts)
- channel membership inspection and kick flows cover counts, full member arrays, stable member ids, and silent kick no-op cases through `ctx.channels` helpers - [tests-e2e/cloudflare/tests/ctx-channels.spec.ts](./tests-e2e/cloudflare/tests/ctx-channels.spec.ts)
- runtime connection quality, latency, and buffered amount are surfaced to handlers - [tests-e2e/cloudflare/tests/ctx-quality.spec.ts](./tests-e2e/cloudflare/tests/ctx-quality.spec.ts)
- SQL context coverage includes note persistence, parameter binding, `SqlResult.one()` null-on-miss behavior, and `SqlResult.raw()` behavior - [tests-e2e/cloudflare/tests/ctx-sql.spec.ts](./tests-e2e/cloudflare/tests/ctx-sql.spec.ts)
- KV context coverage includes set/get/delete, delete-no-op behavior, TTL expiry, overwrite behavior, and immediate read-after-write behavior - [tests-e2e/cloudflare/tests/ctx-kv.spec.ts](./tests-e2e/cloudflare/tests/ctx-kv.spec.ts)
- scheduled task contexts can target live or stale connections and broadcast to tags/connections - [tests-e2e/cloudflare/tests/scheduled.spec.ts](./tests-e2e/cloudflare/tests/scheduled.spec.ts)

### 6. Acknowledgements (`ack`)

What it covers:

- `.ack()`
- top-level `ctx.ack()`
- `_ack` emission keyed by client-provided `_ackId`

#### Unit / integrated

- the ack primitive has singleton identity and only extends top-level connection contexts - [server/src/ack/ack.spec.ts](./server/src/ack/ack.spec.ts)
- type-layer fixture pins the `AckPrimitive` shape, the `__wskit: 'ack'` tag, and the `PrimitiveRef` assignability of `ack` itself - [server/src/ack/ack.test.ts](./server/src/ack/ack.test.ts)
- builder registration, grouping, and type availability of `ctx.ack()` are covered - [server/src/ack/with.spec.ts](./server/src/ack/with.spec.ts), [server/src/\_builder/integration.spec.ts](./server/src/_builder/integration.spec.ts), [server/src/\_builder/integration.test.ts](./server/src/_builder/integration.test.ts)

#### E2E

- successful handlers emit `_ack` with the original `_ackId` - [tests-e2e/cloudflare/tests/ack.spec.ts](./tests-e2e/cloudflare/tests/ack.spec.ts)
- thrown handlers do not emit `_ack`, multiple acks remain distinct, and frames without `_ackId` stay silent - [tests-e2e/cloudflare/tests/ack.spec.ts](./tests-e2e/cloudflare/tests/ack.spec.ts)

### 7. Request/response (`request`)

What it covers:

- `.request(...)`
- `ctx.respond(...)`
- scoped request handling in namespaces and channels

#### Unit / integrated

- request primitives preserve event identity, validators, and handler metadata - [server/src/request/request.spec.ts](./server/src/request/request.spec.ts)
- type-layer fixture proves the literal event name flows through, `ctx.respond()` is typed to `TResponse`, payload is inferred from a parse function or Standard Schema, requests without a validator give `unknown` payload, and a carried `TCtx` is threaded through the handler - [server/src/request/request.test.ts](./server/src/request/request.test.ts)
- request runtime reads correlation ids, sends routed responses, rejects double-respond, preserves hanging requests when `ctx.respond()` is never called, and clears active connection state after errors - [server/src/request/runtime.spec.ts](./server/src/request/runtime.spec.ts)
- builder registration, duplicate detection, grouping, and typed payload/response flow are covered - [server/src/request/with.spec.ts](./server/src/request/with.spec.ts), [server/src/\_builder/integration.spec.ts](./server/src/_builder/integration.spec.ts), [server/src/\_builder/integration.test.ts](./server/src/_builder/integration.test.ts)

#### E2E

- top-level, namespace-scoped, and channel-scoped requests respond with the correct routing and request id - [tests-e2e/cloudflare/tests/request.spec.ts](./tests-e2e/cloudflare/tests/request.spec.ts)
- handlers that never call `ctx.respond()` leave the request unresolved as intended - [tests-e2e/cloudflare/tests/request.spec.ts](./tests-e2e/cloudflare/tests/request.spec.ts)

### 8. Intercepts

What it covers:

- top-level, namespace, and channel pre-intercepts
- top-level, namespace, and channel post-intercepts
- `Block` behavior and post-intercept compile validation

#### Unit / integrated

- intercept primitives distinguish pre-validation and post-validation paths and keep repeatable identity - [server/src/intercept/intercept.spec.ts](./server/src/intercept/intercept.spec.ts)
- type-layer fixture pins `PreInterceptPrimitive<TCtx>` and `PostInterceptPrimitive<TEvent, TPayload, TCtx>` generics so handlers can read typed `ctx` (e.g. `ctx.userId`, `ctx.orgId`) and typed payload fields - [server/src/intercept/intercept.test.ts](./server/src/intercept/intercept.test.ts)
- runtime coverage proves ordered rewriting, validated payload delivery to post-intercepts, propagation of `Block`, and cleanup of active connection state - [server/src/intercept/runtime.spec.ts](./server/src/intercept/runtime.spec.ts)
- builder wrappers cover top-level, namespace, and group registration and typing - [server/src/intercept/with.spec.ts](./server/src/intercept/with.spec.ts), [server/src/\_builder/integration.spec.ts](./server/src/_builder/integration.spec.ts)
- compile-time validation rejects post-intercepts that target events with no matching handler in the relevant scope - [server/src/\_engine/compile/compile.spec.ts](./server/src/_engine/compile/compile.spec.ts)

#### E2E

- pre- and post-intercepts rewrite payloads correctly at top-level, namespace, and channel scope - [tests-e2e/cloudflare/tests/intercept.spec.ts](./tests-e2e/cloudflare/tests/intercept.spec.ts)
- void returns pass messages through unchanged, and `Block` prevents handler execution where expected - [tests-e2e/cloudflare/tests/intercept.spec.ts](./tests-e2e/cloudflare/tests/intercept.spec.ts)

### 9. Channels

What it covers:

- static channels
- dynamic/regex-backed scopes
- subscribe/unsubscribe lifecycle hooks
- channel-scoped send/broadcast, membership events, and kicking

#### Unit / integrated

- channel builders cover static names, dynamic scopes, outgoing visibility, lifecycle hooks, callback composition, and duplicate-scope rejection - [server/src/channel/with.spec.ts](./server/src/channel/with.spec.ts)
- channel lifecycle primitives cover `onBeforeSubscribe`, `onSubscribe`, and `onUnsubscribe` setup forms - [server/src/channel/lifecycle.spec.ts](./server/src/channel/lifecycle.spec.ts)
- runtime coverage proves subscribe/unsubscribe flow, member sync frames, invalid unsubscribe handling, same-name isolation across channel families, ordering guarantees around `onBeforeSubscribe`, and `ctx.channels.kick(...)` end-to-end runtime behavior - [server/src/channel/runtime.spec.ts](./server/src/channel/runtime.spec.ts), [server/src/channel/runtime.kick.spec.ts](./server/src/channel/runtime.kick.spec.ts)
- engine runtime tests prove channel-scoped delivery only reaches matching members and that same-name memberships in other scopes do not authorize scoped traffic - [server/src/\_engine/runtime/messages.spec.ts](./server/src/_engine/runtime/messages.spec.ts)

#### E2E

- static channel coverage includes subscribe/unsubscribe semantics, idempotent subscribe, unknown-channel errors, invalid unsubscribe and publish handling, membership join/leave frames, and channel-scoped streams - [tests-e2e/cloudflare/tests/channel-static.spec.ts](./tests-e2e/cloudflare/tests/channel-static.spec.ts)
- static channel lifecycle/order coverage also proves `_subscribeOk` reaches the joining client before peers observe `_memberJoin`, manual `_unsubscribe` emits peer `_memberLeave`, connection drop emits peer `_memberLeave`, and disconnect still triggers `onUnsubscribe` effects - [tests-e2e/cloudflare/tests/channel-static.spec.ts](./tests-e2e/cloudflare/tests/channel-static.spec.ts)
- dynamic channel coverage includes regex matching, scoped isolation across different suffixes, scoped broadcasts, subscribe lifecycle hooks, sync and async subscription rejection, unknown-scope errors, exposed matched-name metadata, and shared broadcast groups for clients on the same matched channel name - [tests-e2e/cloudflare/tests/channel-dynamic.spec.ts](./tests-e2e/cloudflare/tests/channel-dynamic.spec.ts)
- channel membership inspection and kick behavior is also covered from application handlers through `ctx.channels` - [tests-e2e/cloudflare/tests/ctx-channels.spec.ts](./tests-e2e/cloudflare/tests/ctx-channels.spec.ts)

### 10. Namespaces

What it covers:

- `.namespace(...)`
- namespace-local outgoing events
- namespace-local send/broadcast and stream/request behavior

#### Unit / integrated

- namespace primitives are frozen containers for mixed child primitives - [server/src/namespace/namespace.spec.ts](./server/src/namespace/namespace.spec.ts)
- builder wrappers cover registration, local outgoing visibility, callback composition, and duplicate-name rejection - [server/src/namespace/with.spec.ts](./server/src/namespace/with.spec.ts), [server/src/\_builder/integration.spec.ts](./server/src/_builder/integration.spec.ts), [server/src/\_builder/integration.test.ts](./server/src/_builder/integration.test.ts)

#### E2E

- `ctx.namespace.send(...)` targets the triggering connection only - [tests-e2e/cloudflare/tests/namespace.spec.ts](./tests-e2e/cloudflare/tests/namespace.spec.ts)
- `ctx.namespace.broadcast(...)` reaches all connections - [tests-e2e/cloudflare/tests/namespace.spec.ts](./tests-e2e/cloudflare/tests/namespace.spec.ts)
- namespace streams and namespace name exposure are covered live - [tests-e2e/cloudflare/tests/namespace.spec.ts](./tests-e2e/cloudflare/tests/namespace.spec.ts)
- namespace-scoped requests are exercised by the request suite - [tests-e2e/cloudflare/tests/request.spec.ts](./tests-e2e/cloudflare/tests/request.spec.ts)
- namespace-scoped intercept behavior is exercised by the intercept suite - [tests-e2e/cloudflare/tests/intercept.spec.ts](./tests-e2e/cloudflare/tests/intercept.spec.ts)

### 11. Streams

What it covers:

- `.stream(...).generate(...)`
- chunk delivery, `_streamOk`, `_streamEnd`, `_streamCancel`
- nudges
- broadcast streams
- stream ownership and persistence hooks

#### Unit / integrated

- stream declarations preserve start validators, nudge declarations, and the paired stream/generate identity model - [server/src/stream/stream.spec.ts](./server/src/stream/stream.spec.ts)
- builder wrappers cover typing, nudges, broadcast mode, channel usage, and callback composition - [server/src/stream/with.spec.ts](./server/src/stream/with.spec.ts), [server/src/\_builder/integration.spec.ts](./server/src/_builder/integration.spec.ts), [server/src/\_builder/integration.test.ts](./server/src/_builder/integration.test.ts)
- compile-time stream fixtures prove where `ctx.nudges()` is present or absent across top-level, group, namespace, and channel scopes, and that parent builders remain usable after `.stream()` - [server/src/stream/types.test-d.ts](./server/src/stream/types.test-d.ts)
- runtime coverage proves `_streamEnd` routing metadata, broadcast fan-out, non-owner cancel rejection, non-broadcast behavior, `Defer` warning/direct `_error` behavior that skips `onError`, nudge buffering for unknown streams/events, and attachment persistence on start/end - [server/src/stream/runtime.spec.ts](./server/src/stream/runtime.spec.ts)

#### E2E

- basic stream startup, chunk delivery, `_streamOk`, errors, cancel, empty generators, early throw, cancellation finalizers, foreign-cancel rejection, and concurrent stream ids are covered live - [tests-e2e/cloudflare/tests/stream-basic.spec.ts](./tests-e2e/cloudflare/tests/stream-basic.spec.ts)
- stream wire semantics also cover typed error-factory codes surviving stream failures and `_streamEnd` appearing only on natural completion, not client cancellation - [tests-e2e/cloudflare/tests/stream-basic.spec.ts](./tests-e2e/cloudflare/tests/stream-basic.spec.ts)
- broadcast streams deliver chunks to the trigger connection and peers, with one copy per chunk on the triggering connection - [tests-e2e/cloudflare/tests/stream-broadcast.spec.ts](./tests-e2e/cloudflare/tests/stream-broadcast.spec.ts)
- nudge delivery, typed mixed nudges, cadence changes, early nudges, stop behavior, and repeated pause-nudge coalescing are covered live - [tests-e2e/cloudflare/tests/stream-nudges.spec.ts](./tests-e2e/cloudflare/tests/stream-nudges.spec.ts)
- stream behavior inside channels and namespaces is also exercised by those dedicated suites - [tests-e2e/cloudflare/tests/channel-static.spec.ts](./tests-e2e/cloudflare/tests/channel-static.spec.ts), [tests-e2e/cloudflare/tests/namespace.spec.ts](./tests-e2e/cloudflare/tests/namespace.spec.ts)

### 12. Replay

What it covers:

- history replay
- snapshot replay
- custom replay
- `sendReplay`
- routing across top-level and channel scopes
- retention and durability modes

#### Unit / integrated

- replay builders enforce snapshot-only option guards and preserve callback configuration; the `with.spec.ts` file additionally covers `.replayCustom()` builder registration, `onBeforeSend`/`onAfterSend`/`onReplay` hook wiring, callback-form chaining back to the parent, and `ChannelBuilder` integration with typed `ctx.sql`, `ctx.meta`, `msg.wire.seq`, and `msg.wire.messageId` - [server/src/replay/builder.spec.ts](./server/src/replay/builder.spec.ts), [server/src/replay/with.spec.ts](./server/src/replay/with.spec.ts)
- replay primitives cover automatic replay options, reducer behavior, context extension, scoped `sendReplay`, and replay-request matching - [server/src/replay/replay.spec.ts](./server/src/replay/replay.spec.ts)
- type-layer fixture pins the `ReplayPrimitive` shape, `ReplayType`, `ReplayDurability`, and the `snapshotKey`/`reduce` callback signatures - [server/src/replay/replay.test.ts](./server/src/replay/replay.test.ts)
- replay runtime covers schema/index creation, scope ownership matching, row construction from final wire payloads, history persistence, snapshot reduction and deletion, pruning, and row loading across normal and channel scopes - [server/src/replay/runtime.spec.ts](./server/src/replay/runtime.spec.ts)
- custom replay coverage proves top-level cloning, channel filtering, `ctx.sendReplay()` not re-triggering `onBeforeSend`, and strict-durability ordering - [server/src/replay/custom/custom.spec.ts](./server/src/replay/custom/custom.spec.ts)
- type-layer fixture pins the user-visible `wire` shape difference between the top-level and channel variants of custom replay: only the channel variant exposes `wire.channel` and `wire.channelScope` - [server/src/replay/custom/custom.test.ts](./server/src/replay/custom/custom.test.ts)
- engine-level validation enforces replay requirements such as pairing replay with persistent sequencing, and tests replay durability hook ordering - [server/src/\_engine/engine.modules.spec.ts](./server/src/_engine/engine.modules.spec.ts)

#### E2E

- history replay covers stored message retrieval, exclude-list behavior, sequence presence, channel scoping, nonzero cursors, retention by count and age, strict durability, reconnect behavior, and programmatic `sendReplay` - [tests-e2e/cloudflare/tests/replay-history.spec.ts](./tests-e2e/cloudflare/tests/replay-history.spec.ts)
- snapshot replay covers latest-per-key semantics, reducer merging, reducer deletion, retention, age pruning, channel snapshots, and best-effort durability - [tests-e2e/cloudflare/tests/replay-snapshot.spec.ts](./tests-e2e/cloudflare/tests/replay-snapshot.spec.ts)
- custom replay covers user-defined history payloads, confirmation hooks, channel scoping, and nonzero cursors - [tests-e2e/cloudflare/tests/replay-custom.spec.ts](./tests-e2e/cloudflare/tests/replay-custom.spec.ts)
- replay requests sent to handlers without replay enabled are handled gracefully - [tests-e2e/cloudflare/tests/incoming.spec.ts](./tests-e2e/cloudflare/tests/incoming.spec.ts)

### 13. Scheduled tasks

What it covers:

- `.scheduled(...)`
- one-shot and recurring tasks
- cancellation filters
- retry and dead-letter behavior
- timer/alarm integration

#### Unit / integrated

- scheduled primitives cover handler-backed declarations (with and without `.data()` schemas), a throw when `.run(...)` is omitted, storage/timer requirements, and builder registration/duplicate detection - [server/src/scheduled/scheduled.spec.ts](./server/src/scheduled/scheduled.spec.ts), [server/src/scheduled/with.spec.ts](./server/src/scheduled/with.spec.ts)
- runtime coverage proves scheduler bootstrap, recurring baselines, one-shot queueing, filtered cancel semantics, retry with default or custom backoff, dead-lettering, `retry:false`, alarm-vs-timeout behavior, and serialization of custom backoff - [server/src/scheduled/runtime.spec.ts](./server/src/scheduled/runtime.spec.ts)
- compile-time fixture pins the scheduled-task API: `ctx.schedule()` rejects `data` for no-data tasks, requires the right shape for tasks declared with `.data(schema)`, threads typed `data` into `.run(...)`, supports optional schemas, schedules group-scoped tasks, and exposes typed `ctx.sql.exec<TRow>()` (with `unknown` rows when no row type is given) inside run handlers - [server/src/scheduled/types.test-d.ts](./server/src/scheduled/types.test-d.ts)

#### E2E

- one-shot, recurring, cancel-before-fire, filtered cancel, and no-match / unknown-id cancel semantics are covered live - [tests-e2e/cloudflare/tests/scheduled.spec.ts](./tests-e2e/cloudflare/tests/scheduled.spec.ts)
- retry coverage includes default retry, custom backoff retry, empty-backoff immediate DLQ, and permanent-failure DLQ persistence - [tests-e2e/cloudflare/tests/scheduled.spec.ts](./tests-e2e/cloudflare/tests/scheduled.spec.ts)
- task-context helpers cover `sendToConnection` for live and stale ids, tag-targeted `sendTo`, and full-connection `broadcast` behavior - [tests-e2e/cloudflare/tests/scheduled.spec.ts](./tests-e2e/cloudflare/tests/scheduled.spec.ts)

### 14. Infrastructure primitives

What it covers:

- `sequence`
- `dedup`
- `heartbeat`
- `hibernation`

#### Unit / integrated

- builder registration covers ordering, defaults, composition, and duplicate rejection for all infrastructure primitives - [server/src/\_builder/infrastructure.spec.ts](./server/src/_builder/infrastructure.spec.ts)
- `sequence` covers singleton identity, optional persistence requirements, protocol-event skipping, `_seq` injection, module-owned outgoing frames, SQLite bootstrapping, and restart continuity - [server/src/sequence/sequence.spec.ts](./server/src/sequence/sequence.spec.ts), [server/src/sequence/runtime.spec.ts](./server/src/sequence/runtime.spec.ts); type-layer fixture pins the `SequencePrimitive` shape and `SequenceOptions.persist` typing - [server/src/sequence/sequence.test.ts](./server/src/sequence/sequence.test.ts)
- `dedup` covers singleton identity, `_messageId` injection for normal and module-owned outgoing frames, protocol-event skipping, incoming duplicate suppression windows, per-connection isolation, bypass on retry dispatch, and disabled mode when cap is zero - [server/src/dedup/dedup.spec.ts](./server/src/dedup/dedup.spec.ts), [server/src/dedup/incoming.spec.ts](./server/src/dedup/incoming.spec.ts); type-layer fixture pins the `DedupPrimitive` shape and `__wskit: 'dedup'` tag - [server/src/dedup/dedup.test.ts](./server/src/dedup/dedup.test.ts)
- `heartbeat` covers idle timer refresh, ping scheduling, pong/latency rolling averages, connection quality derivation, and safe cleanup - [server/src/heartbeat/heartbeat.spec.ts](./server/src/heartbeat/heartbeat.spec.ts), [server/src/heartbeat/runtime.spec.ts](./server/src/heartbeat/runtime.spec.ts); type-layer fixture pins the `HeartbeatPrimitive` shape and `timeout` field type - [server/src/heartbeat/heartbeat.test.ts](./server/src/heartbeat/heartbeat.test.ts)
- `hibernation` covers registration defaults and adapter-setting propagation - [server/src/hibernation/hibernation.spec.ts](./server/src/hibernation/hibernation.spec.ts); type-layer fixture pins the `enabled` flag and the `__requires.hibernation` capability marker - [server/src/hibernation/hibernation.test.ts](./server/src/hibernation/hibernation.test.ts)
- engine-level checks enforce replay/persistent-sequence coupling and hibernation adapter support - [server/src/\_engine/engine.modules.spec.ts](./server/src/_engine/engine.modules.spec.ts)

#### E2E

- sequence numbers are present, monotonic, and increment across outgoing frames - [tests-e2e/cloudflare/tests/sequence.spec.ts](./tests-e2e/cloudflare/tests/sequence.spec.ts)
- outgoing `_messageId` generation and incoming duplicate suppression are covered live - [tests-e2e/cloudflare/tests/dedup.spec.ts](./tests-e2e/cloudflare/tests/dedup.spec.ts)
- idle heartbeat closure and activity-based timeout refresh are covered live - [tests-e2e/cloudflare/tests/heartbeat.spec.ts](./tests-e2e/cloudflare/tests/heartbeat.spec.ts)
- hibernation preserves channel memberships, tags, tag-targeted sends, channel membership counts, and SQL-backed state across wake - [tests-e2e/cloudflare/tests/hibernation.spec.ts](./tests-e2e/cloudflare/tests/hibernation.spec.ts)

### 15. Error handling and control-flow helpers

What it covers:

- `.errors(...)`
- declared error factories
- `Disconnect`, `RejectUpgrade`, `Defer`, `DeferExhausted`
- validation error routing

#### Unit / integrated

- server-side close-code catalog, `Disconnect`, `RejectUpgrade`, and `DeferExhausted` semantics are covered - [server/src/errors/errors.spec.ts](./server/src/errors/errors.spec.ts)
- type-layer fixture pins the `__wskit` tags on `Disconnect`, `RejectUpgrade`, and `Defer`, the `DeferExhausted` factory shape, `DeferExhausted.matches()` narrowing, and the re-exported core symbols (`Block`, `CloseCodes`, `error`, `ValidationFailed`) - [server/src/errors/errors.test.ts](./server/src/errors/errors.test.ts)
- the `errors(...)` primitive registers declared definitions in setup and rejects duplicate registration - [server/src/errors/primitive.spec.ts](./server/src/errors/primitive.spec.ts), [server/src/errors/with.spec.ts](./server/src/errors/with.spec.ts)
- type-layer fixture pins the `ErrorsPrimitive` tuple shape so declared error codes flow through with their literal types - [server/src/errors/primitive.test.ts](./server/src/errors/primitive.test.ts)
- runtime coverage proves normalization of thrown `WskitError` and unknown values into `_error`, execution of error hooks, scoped validation notifications, and warnings for undeclared thrown errors - [server/src/errors/runtime.spec.ts](./server/src/errors/runtime.spec.ts)
- schema validation helpers convert Standard Schema and parser failures into `ValidationFailed` consistently - [server/src/\_engine/compile/utils.spec.ts](./server/src/_engine/compile/utils.spec.ts)

#### E2E

- registered error factories reach the client intact on the `_error` channel - [tests-e2e/cloudflare/tests/errors-factory.spec.ts](./tests-e2e/cloudflare/tests/errors-factory.spec.ts)
- `Disconnect`, `Defer`, `Block`, manual `ValidationFailed`, `DeferExhausted`, and scoped defer failures are exercised live - [tests-e2e/cloudflare/tests/errors-control-flow.spec.ts](./tests-e2e/cloudflare/tests/errors-control-flow.spec.ts)

### 16. Modules

What it covers:

- `defineModule(...)`
- typed module APIs via `use(ctx)`
- module lifecycle hooks
- module-owned outgoing/errors
- module scheduled tasks

#### Unit / integrated

- `defineModule(...)` validates module ids, preserves typed API access, exposes dependency metadata, and rejects `use(ctx)` outside active wskit context - [server/src/modules/define.spec.ts](./server/src/modules/define.spec.ts)
- module engine wiring covers `onIncoming`, `onOutgoing`, `onInit`, `onShutdown`, scheduled task registration with module-prefixed ids, `getState()` fallback, and ordering relative to top-level pre-intercepts - [server/src/\_engine/engine.modules.spec.ts](./server/src/_engine/engine.modules.spec.ts)

#### E2E

- module lifecycle hooks cover `onConnect`, `onDisconnect`, and reconnect-visible `onShutdown` behavior - [tests-e2e/cloudflare/tests/modules.spec.ts](./tests-e2e/cloudflare/tests/modules.spec.ts)
- module API coverage includes insert/list/get/delete/count CRUD flows against the live Drizzle-backed module surface - [tests-e2e/cloudflare/tests/modules.spec.ts](./tests-e2e/cloudflare/tests/modules.spec.ts)
- module hooks cover outgoing rewrite/counting, incoming rewrite/counting, and `generateId()` / `getState()` observation - [tests-e2e/cloudflare/tests/modules.spec.ts](./tests-e2e/cloudflare/tests/modules.spec.ts)
- module scheduled tasks cover one-shot execution, recurring execution, retry success, and DLQ persistence - [tests-e2e/cloudflare/tests/modules.spec.ts](./tests-e2e/cloudflare/tests/modules.spec.ts)
- typed module-owned errors reach the client with code and detail intact - [tests-e2e/cloudflare/tests/modules.spec.ts](./tests-e2e/cloudflare/tests/modules.spec.ts)

### 17. Cloudflare adapter

What it covers:

- adapter definition helpers
- Durable Object `serve(...)`
- Cloudflare platform providers for SQL, KV, storage, timers, and binary normalization

#### Unit / integrated

- adapter-definition helpers support no-arg engine factories, option passing, hibernation option functions, and independent engine instances - [server/src/\_adapters/define.spec.ts](./server/src/_adapters/define.spec.ts)
- the Cloudflare platform exposes env, storage, SQL, KV, timers, websocket access, binary normalization, and KV expiry cleanup with the expected fallbacks, including `sql.transaction()` falling back to inline execution when `transactionSync` is unavailable on the D1 binding - [server-adapters/cloudflare/src/platform.spec.ts](./server-adapters/cloudflare/src/platform.spec.ts), [server-adapters/cloudflare/src/providers.spec.ts](./server-adapters/cloudflare/src/providers.spec.ts)
- `serve(...)` covers HTTP upgrade rejection, accepted websocket upgrade wiring, hibernation-mode websocket acceptance, rejected upgrade mapping, wake callbacks, and alarm/shutdown RPC wiring into the engine - [server-adapters/cloudflare/src/serve.spec.ts](./server-adapters/cloudflare/src/serve.spec.ts)
- the adapter package's public API surface is type-checked: `serve`, `CloudflareOptions`, and `Platform` are exported, while internal helpers (`createPlatform`, `createStorage`, `createTimers`, `normalizeBinary`) are not reachable from the package root - [server-adapters/cloudflare/src/public-api.test-d.ts](./server-adapters/cloudflare/src/public-api.test-d.ts)

#### E2E

- live websocket upgrade, protocol, lifecycle, and binary behavior all exercise the adapter entrypoint and websocket wiring - [tests-e2e/cloudflare/tests/lifecycle-hooks.spec.ts](./tests-e2e/cloudflare/tests/lifecycle-hooks.spec.ts), [tests-e2e/cloudflare/tests/protocol-pings.spec.ts](./tests-e2e/cloudflare/tests/protocol-pings.spec.ts), [tests-e2e/cloudflare/tests/binary.spec.ts](./tests-e2e/cloudflare/tests/binary.spec.ts)
- hibernation wake, attachment restore, and resumed connection behavior are exercised through the adapter in hibernation mode - [tests-e2e/cloudflare/tests/hibernation.spec.ts](./tests-e2e/cloudflare/tests/hibernation.spec.ts)
- Cloudflare storage providers are exercised live through SQL, KV, replay, scheduled-task, and module suites - [tests-e2e/cloudflare/tests/ctx-sql.spec.ts](./tests-e2e/cloudflare/tests/ctx-sql.spec.ts), [tests-e2e/cloudflare/tests/ctx-kv.spec.ts](./tests-e2e/cloudflare/tests/ctx-kv.spec.ts), [tests-e2e/cloudflare/tests/replay-history.spec.ts](./tests-e2e/cloudflare/tests/replay-history.spec.ts), [tests-e2e/cloudflare/tests/scheduled.spec.ts](./tests-e2e/cloudflare/tests/scheduled.spec.ts), [tests-e2e/cloudflare/tests/modules.spec.ts](./tests-e2e/cloudflare/tests/modules.spec.ts)

## Notes

- The biggest rewrite from the old doc is path accuracy: source-adjacent coverage now lives under `server/src/...`, adapter coverage under `server-adapters/cloudflare/src/...`, and browser/worker coverage under `tests-e2e/cloudflare/tests/...`.
- The current suite is especially strong around scoped behavior: channels, namespaces, streams, replay, scheduled tasks, modules, and infrastructure each have both source-level behavior checks and live Cloudflare coverage.
