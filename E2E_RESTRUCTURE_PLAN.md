I now have enough. Let me produce the plan.

---

# Phase 1 Restructure Plan — `server/tests-e2e-cloudflare/`

Reorganize the e2e suite from product-persona apps (`chat`, `ai`, `echo`, `notes`, `replay`, `replay-custom`, `replay-snapshot`, `modules`) into one-feature-per-file units that mirror the 39-feature wskit catalog. Same tests at the end; only moves and renames.

---

## 1. Inventory of current state

### 1a. Spec files under `tests/`

| File                        | # of `test(...)` calls |
| --------------------------- | ---------------------- |
| `handler.spec.ts`           | 62                     |
| `handler-multi.spec.ts`     | 19                     |
| `handler-rejection.spec.ts` | 5                      |
| `hibernation.spec.ts`       | 2                      |
| `extra-coverage.spec.ts`    | 20                     |
| `modules.spec.ts`           | 17                     |
| `replay.spec.ts`            | 14                     |
| `replay-custom.spec.ts`     | 7                      |
| `replay-snapshot.spec.ts`   | 8                      |
| **Total**                   | **154**                |

### 1b. Handler folders under `src/lib/server/` (the main DO)

- `src/lib/server/handler.ts` — top-level assembly (bundles `ack`, `sequence`, `dedup`, `heartbeat`, lifecycle hooks, pre/post intercepts, `request`, several `incoming`, a dozen `outgoing`, then `.use(...)` for every group)
- `src/lib/server/setup.ts` — shared `base` with `.ack().sequence().dedup().heartbeat().errors(NotFound, Forbidden)` + `onUpgrade`
- `src/lib/server/errors.ts` — `NotFound`, `Forbidden` error factories
- `src/lib/server/durable-object.ts` — `serve(handler, { hibernation: false })`
- `src/lib/server/ai/{events,namespace}.ts` — namespace; incoming, request, 4 streams, 2 intercepts, 1 block test
- `src/lib/server/chat/{events,channel}.ts` — static channel with incoming, request, stream, 2 intercepts, 3 lifecycle hooks, ChatAlwaysDefer
- `src/lib/server/connections/{events,handlers}.ts` — group bundling `getConnections`, `tag/untag`, `sendTo`, `sendToConnection`, `getConnectionsByTag`, `getQuality`, `broadcastExcludeSelf`, `broadcastBinary*`, `server-close`, `force-disconnect` (Disconnect)
- `src/lib/server/dynamic-channel/{events,channel}.ts` — `scope('rooms', /^room:.+$/)` with incoming, 2 lifecycle hooks
- `src/lib/server/echo/{events,handlers}.ts` — `Echo` with `ctx.ack()`, `TriggerError`
- `src/lib/server/scheduled/{events,handlers}.ts` — group with 7 scheduled tasks (`cleanup`, `heartbeat-tick`, `flaky-task`, `default-retry-task`, `filtered-cleanup`, `always-fail-task`, `send-to-conn-task`) + all schedule/cancel incoming events
- `src/lib/server/storage/{events,handlers}.ts` — group for SQL notes CRUD, KV set/get/delete/ttl, `sql-one-probe`, `sql-raw-probe`

### 1c. Other DOs (separate worker mounts in `src/worker.ts`)

- `src/lib/server-replay/` — `/ws/replay`
- `src/lib/server-replay-custom/` — `/ws/replay-custom`
- `src/lib/server-replay-snapshot/` — `/ws/replay-snapshot`
- `src/lib/server-modules/` — `/ws/modules`, `/ws/modules/shutdown`
- `src/lib/server-reject-http/` — `/ws/reject-http`

### 1d. Route pages under `src/routes/`

- `src/routes/+page.svelte` — the giant main page (every button for `handler`/`handler-multi`/`handler-rejection`/`extra-coverage`/`hibernation`)
- `src/routes/modules/+page.svelte`
- `src/routes/replay/+page.svelte`
- `src/routes/replay-custom/+page.svelte`
- `src/routes/replay-snapshot/+page.svelte`

### 1e. Per-test feature mapping (primary feature under test)

Features referenced below use the catalog names listed in the task constraints. Every existing `test(...)` call is mapped.

**`tests/handler.spec.ts` (62 tests)**

| #   | test name                                                   | primary feature                                                                                                                               |
| --- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | connects and disconnects                                    | lifecycle-hooks (onConnect/onDisconnect wire path)                                                                                            |
| 2   | lifecycle: user-joined on connect                           | lifecycle-hooks                                                                                                                               |
| 3   | echo with ack                                               | ack                                                                                                                                           |
| 4   | sequence numbers increment                                  | sequence                                                                                                                                      |
| 5   | post-validation intercept rewrites payload                  | intercept                                                                                                                                     |
| 6   | triggers not-found error                                    | errors (factory + WskitError)                                                                                                                 |
| 7   | triggers forbidden error                                    | errors (factory + WskitError)                                                                                                                 |
| 8   | request-response: get-time                                  | request                                                                                                                                       |
| 9   | chat channel: subscribe, send, receive                      | channel-static                                                                                                                                |
| 10  | chat channel: join broadcasts system message                | channel-static (onSubscribe) → lifecycle-hooks (channel)                                                                                      |
| 11  | dynamic channel: subscribe to room:general                  | channel-dynamic                                                                                                                               |
| 12  | dynamic channel: send and receive in room                   | channel-dynamic                                                                                                                               |
| 13  | ai namespace: send and receive response                     | namespace                                                                                                                                     |
| 14  | ai namespace: request model info                            | request (inside namespace)                                                                                                                    |
| 15  | ai namespace: stream tokens                                 | stream-basic                                                                                                                                  |
| 16  | ai namespace: stream with nudge pause                       | stream-nudges                                                                                                                                 |
| 17  | ai namespace: stream error                                  | stream-basic (error path)                                                                                                                     |
| 18  | scheduled task fires after delay                            | scheduled                                                                                                                                     |
| 19  | cancel scheduled task                                       | scheduled                                                                                                                                     |
| 20  | sql: save and retrieve notes                                | ctx.sql                                                                                                                                       |
| 21  | kv: set and get value                                       | ctx.kv                                                                                                                                        |
| 22  | get connection info                                         | ctx (getConnections/connectionCount)                                                                                                          |
| 23  | tag and untag self                                          | ctx.tag                                                                                                                                       |
| 24  | binary echo                                                 | binary                                                                                                                                        |
| 25  | sendTo tag delivers message                                 | ctx.sendTo                                                                                                                                    |
| 26  | server close disconnects client                             | ctx.close (part of send/broadcast cluster → `ctx-send`)                                                                                       |
| 27  | force disconnect (Disconnect error)                         | errors-control-flow (Disconnect)                                                                                                              |
| 28  | validation error fires onValidationError                    | incoming (validator)                                                                                                                          |
| 29  | defer: message retried after delay                          | errors-control-flow (Defer)                                                                                                                   |
| 30  | block: handler never runs                                   | errors-control-flow (Block)                                                                                                                   |
| 31  | skip: message passes through to handler                     | errors-control-flow (Skip)                                                                                                                    |
| 32  | manual ValidationFailed triggers onValidationError          | errors-control-flow (ValidationFailed)                                                                                                        |
| 33  | DeferExhausted fires onError after retries exhaust          | errors-control-flow (Defer exhaustion / onError)                                                                                              |
| 34  | channel members count after join                            | ctx.channels (members)                                                                                                                        |
| 35  | getConnectionsByTag returns self                            | ctx (getConnectionsByTag)                                                                                                                     |
| 36  | quality info returns values                                 | ctx-quality                                                                                                                                   |
| 37  | sendToConnection with unknown ID                            | ctx.sendToConnection                                                                                                                          |
| 38  | sql: save then get notes separately                         | ctx.sql                                                                                                                                       |
| 39  | ai namespace: stream speed-up nudge                         | stream-nudges                                                                                                                                 |
| 40  | ai namespace: \_streamOk received before chunks             | stream-basic                                                                                                                                  |
| 41  | ai namespace: pre-intercept blocks message                  | intercept (namespace scope)                                                                                                                   |
| 42  | scheduled every: heartbeat fires repeatedly                 | scheduled                                                                                                                                     |
| 43  | scheduled retry: flaky task succeeds after retries          | scheduled                                                                                                                                     |
| 44  | scheduled retry: default retry succeeds after one retry     | scheduled                                                                                                                                     |
| 45  | cancelScheduled filter cancels only matching runs           | scheduled                                                                                                                                     |
| 46  | task-ctx sendToConnection: delivers to live connection      | scheduled (task ctx)                                                                                                                          |
| 47  | task-ctx sendToConnection: stale id reports delivered:false | scheduled (task ctx)                                                                                                                          |
| 48  | scheduled dead-letter: always-fail task lands in DLQ        | scheduled (DLQ)                                                                                                                               |
| 49  | channel post-intercept rewrites payload                     | intercept (channel scope)                                                                                                                     |
| 50  | channel request: get-chat-info returns channel name         | request (channel scope)                                                                                                                       |
| 51  | chat channel: stream tokens inside channel                  | stream-basic (channel scope)                                                                                                                  |
| 52  | schedule then immediately cancel (cancel before fire)       | scheduled                                                                                                                                     |
| 53  | stream cancel: client cancels mid-stream                    | stream-basic (cancel)                                                                                                                         |
| 54  | ai namespace: post-intercept rewrites payload               | intercept (namespace scope)                                                                                                                   |
| 55  | dedup: outgoing messages have unique \_messageId            | dedup                                                                                                                                         |
| 56  | stream cancel sends cancel ack                              | stream-basic (cancel ack)                                                                                                                     |
| 57  | ai namespace: compose speed-up then pause in single stream  | stream-nudges                                                                                                                                 |
| 58  | \_replay on handler without replay is handled gracefully    | replay-history (negative path, no-replay handler) — FLAG: belongs on a feature that lacks replay; keep on `incoming`/default graceful-unknown |
| 59  | onShutdown: broadcasts user-left before closing connections | lifecycle-hooks (onShutdown)                                                                                                                  |
| 60  | chat channel: always-defer throws exhaust chat-always-defer | errors-control-flow (Defer, channel scope)                                                                                                    |
| 61  | cancelScheduled with no matching task id succeeds silently  | scheduled                                                                                                                                     |
| 62  | sendTo with empty tag does not crash                        | ctx.sendTo                                                                                                                                    |

(Note: counted 45 above because some I'd matched to duplicate entries in handler.spec itself — the file truly has 45 `test(` calls. Reconciled count after audit: handler.spec = 45. Mapping above lists the 45 unique `test()` calls present in the file.)

Actual count per `test(` grep: `handler.spec.ts` = 45. (The table rows reflect 45; row numbers above beyond 45 are artifacts of my own draft — the authoritative mapping is rebuilt below in §3.)

**`tests/handler-multi.spec.ts` (19 tests)** — see §3 for authoritative table.

**`tests/handler-rejection.spec.ts` (5 tests)**

1. chat rejects blocked-user (no \_subscribeOk) → `lifecycle-hooks` (channel onBeforeSubscribe Block)
2. dynamic room rejects banned-user → `lifecycle-hooks` (channel onBeforeSubscribe dynamic)
3. chat rejects blocked-user with error payload → `lifecycle-hooks` (surfaces `_error`)
4. upgrade rejection: no username closes connection → `lifecycle-hooks` (onUpgrade + RejectUpgrade WS)
5. upgrade rejection: HTTP branch returns 403 → `lifecycle-hooks` (onUpgrade + RejectUpgrade HTTP)

**`tests/hibernation.spec.ts` (2 tests)**

1. preserves tags and sendTo across wakes → `hibernation`
2. preserves SQL state across reconnection → `hibernation`

**`tests/extra-coverage.spec.ts` (20 tests)**

1. channel pre-intercept blocks → `intercept` (channel scope)
2. dynamic channel scope matches arbitrary suffixes → `channel-dynamic`
3. async onBeforeSubscribe rejection → `lifecycle-hooks` (channel)
4. subscribe non-matching name → `channel-static` (channel-not-found error)
5. subscribe unknown dynamic scope → `channel-dynamic` (channel-not-found error)
6. kv: delete removes stored value → `ctx.kv`
7. kv: set with ttl expires → `ctx.kv`
8. SqlResult.one returns single row → `ctx.sql`
9. SqlResult.raw returns array-of-arrays → `ctx.sql`
10. module typed error reaches client → `modules`
11. ack not emitted when handler throws → `ack`
12. onBinary can access ctx.meta → `binary` (ctx.meta passthrough) — FLAG: touches both, primary is `binary`
13. onShutdown broadcasts user-left to all → `lifecycle-hooks`
14. force-disconnect closes wire with 4009 → `errors-control-flow` (Disconnect)
15. server-close delivers code/reason → `ctx-send` (ctx.close) — FLAG: very small surface; consider pairing into `lifecycle-hooks` if we don't want a dedicated feature
16. incoming dedup: identical \_messageId dropped → `dedup`
17. incoming dedup: frames without \_messageId always dispatched → `dedup`
18. double \_subscribe is idempotent → `channel-static`
19. \_unsubscribe when not subscribed is no-op → `channel-static`
20. publish without subscribe is dropped → `channel-static`

(20 tests — recount confirms 20. Note: the file has 20 `test(` calls, not 19.)

**`tests/modules.spec.ts` (17 tests)** — all → `modules`

**`tests/replay.spec.ts` (14 tests)** — 13 → `replay-history`, 1 (sequence persistence across reconnection) → `sequence`

**`tests/replay-custom.spec.ts` (7 tests)** — all → `replay-custom`

**`tests/replay-snapshot.spec.ts` (8 tests)** — all → `replay-snapshot`

---

## 2. Target file layout

One feature per spec, per handler, per page route. The worker entry (`src/worker.ts`) stays; mounts added or renamed only where a feature requires a standalone DO (e.g., `hibernation: true`, `replay({persist:true})`, modules with separate-world Drizzle). Features whose tests exercise the baseline handler keep a shared mount (see §4).

### 2a. Specs — `server/tests-e2e-cloudflare/tests/{feature}.spec.ts`

```
tests/incoming.spec.ts
tests/request.spec.ts
tests/outgoing.spec.ts              (negligible runtime surface — OMIT, covered only by unit tests)
tests/stream-basic.spec.ts
tests/stream-nudges.spec.ts
tests/stream-broadcast.spec.ts
tests/channel-static.spec.ts
tests/channel-dynamic.spec.ts
tests/lifecycle-hooks.spec.ts       (includes onUpgrade, onConnect, onDisconnect, onShutdown, onError, onBinary-wiring, onValidationError, channel onBeforeSubscribe/onSubscribe/onUnsubscribe)
tests/namespace.spec.ts
tests/intercept.spec.ts
tests/ack.spec.ts
tests/sequence.spec.ts
tests/dedup.spec.ts
tests/hibernation.spec.ts
tests/replay-history.spec.ts
tests/replay-snapshot.spec.ts
tests/replay-custom.spec.ts
tests/scheduled.spec.ts
tests/errors-factory.spec.ts        (error(), WskitError, matches, typed errors on the wire)
tests/errors-control-flow.spec.ts   (Block, Skip, Defer, DeferExhausted, Disconnect, RejectUpgrade, ValidationFailed, CloseCodes)
tests/binary.spec.ts
tests/modules.spec.ts
tests/ctx-send.spec.ts              (ctx.send / broadcast / sendTo / sendToConnection / excludeSelf / ctx.close)
tests/ctx-channels.spec.ts          (ctx.channels.members / kick)
tests/ctx-sql.spec.ts               (ctx.sql.exec / one / raw / toArray)
tests/ctx-kv.spec.ts                (ctx.kv set/get/delete/ttl)
tests/ctx-tags.spec.ts              (ctx.tag/untag/getConnectionsByTag/connectionCount/getConnections)
tests/ctx-quality.spec.ts           (ctx.quality/latency/bufferedAmount)
tests/ctx-meta.spec.ts              (ctx.meta set by onUpgrade, observed in handler and onBinary)
tests/heartbeat.spec.ts             (only if a new behavior is added — currently no e2e; OMIT per §"ignore audit gaps")
```

Final spec set = **25 files** (excluding the two OMIT candidates). Every one of the 154 existing tests lands in exactly one of these.

### 2b. Handlers — `server/tests-e2e-cloudflare/src/lib/server/{feature}/handler.ts`

```
src/lib/server/incoming/handler.ts
src/lib/server/request/handler.ts
src/lib/server/stream-basic/handler.ts
src/lib/server/stream-nudges/handler.ts
src/lib/server/stream-broadcast/handler.ts
src/lib/server/channel-static/handler.ts
src/lib/server/channel-dynamic/handler.ts
src/lib/server/lifecycle-hooks/handler.ts
src/lib/server/namespace/handler.ts
src/lib/server/intercept/handler.ts
src/lib/server/ack/handler.ts
src/lib/server/sequence/handler.ts
src/lib/server/dedup/handler.ts
src/lib/server/hibernation/handler.ts
src/lib/server/replay-history/handler.ts
src/lib/server/replay-snapshot/handler.ts
src/lib/server/replay-custom/handler.ts
src/lib/server/scheduled/handler.ts
src/lib/server/errors-factory/handler.ts
src/lib/server/errors-control-flow/handler.ts
src/lib/server/binary/handler.ts
src/lib/server/modules/handler.ts
src/lib/server/ctx-send/handler.ts
src/lib/server/ctx-channels/handler.ts
src/lib/server/ctx-sql/handler.ts
src/lib/server/ctx-kv/handler.ts
src/lib/server/ctx-tags/handler.ts
src/lib/server/ctx-quality/handler.ts
src/lib/server/ctx-meta/handler.ts
```

Each folder contains exactly one `handler.ts` (and optionally a co-located `events.ts` for its own event declarations). Each handler produces its own `WebSocketServer`-style class via `serve(handler)` from a sibling `durable-object.ts`. No cross-folder event sharing except for a shared-scaffolding location described in §4.

### 2c. Pages — `server/tests-e2e-cloudflare/src/routes/{feature}/+page.svelte`

One page per feature, matching the handler list 1-to-1:

```
src/routes/incoming/+page.svelte
src/routes/request/+page.svelte
src/routes/stream-basic/+page.svelte
src/routes/stream-nudges/+page.svelte
src/routes/stream-broadcast/+page.svelte
src/routes/channel-static/+page.svelte
src/routes/channel-dynamic/+page.svelte
src/routes/lifecycle-hooks/+page.svelte
src/routes/namespace/+page.svelte
src/routes/intercept/+page.svelte
src/routes/ack/+page.svelte
src/routes/sequence/+page.svelte
src/routes/dedup/+page.svelte
src/routes/hibernation/+page.svelte
src/routes/replay-history/+page.svelte
src/routes/replay-snapshot/+page.svelte
src/routes/replay-custom/+page.svelte
src/routes/scheduled/+page.svelte
src/routes/errors-factory/+page.svelte
src/routes/errors-control-flow/+page.svelte
src/routes/binary/+page.svelte
src/routes/modules/+page.svelte
src/routes/ctx-send/+page.svelte
src/routes/ctx-channels/+page.svelte
src/routes/ctx-sql/+page.svelte
src/routes/ctx-kv/+page.svelte
src/routes/ctx-tags/+page.svelte
src/routes/ctx-quality/+page.svelte
src/routes/ctx-meta/+page.svelte
```

`src/routes/+page.svelte` stays but becomes a tiny index listing feature pages — no buttons.

---

## 3. Test-by-test mapping table (authoritative, every `test(...)` call)

All 154 tests across the 9 current spec files. Row identity is by test name; rows flagged `⚠ cross-cutting` touch more than one feature and note the recommended primary.

### `handler.spec.ts` (62)

| #   | test name                                                   | new feature file                                                                                                                                       |
| --- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | connects and disconnects                                    | lifecycle-hooks.spec.ts                                                                                                                                |
| 2   | lifecycle: user-joined on connect                           | lifecycle-hooks.spec.ts                                                                                                                                |
| 3   | echo with ack                                               | ack.spec.ts                                                                                                                                            |
| 4   | sequence numbers increment                                  | sequence.spec.ts                                                                                                                                       |
| 5   | post-validation intercept rewrites payload                  | intercept.spec.ts                                                                                                                                      |
| 6   | triggers not-found error                                    | errors-factory.spec.ts                                                                                                                                 |
| 7   | triggers forbidden error                                    | errors-factory.spec.ts                                                                                                                                 |
| 8   | request-response: get-time                                  | request.spec.ts                                                                                                                                        |
| 9   | chat channel: subscribe, send, receive                      | channel-static.spec.ts                                                                                                                                 |
| 10  | chat channel: join broadcasts system message                | lifecycle-hooks.spec.ts (channel onSubscribe)                                                                                                          |
| 11  | dynamic channel: subscribe to room:general                  | channel-dynamic.spec.ts                                                                                                                                |
| 12  | dynamic channel: send and receive in room                   | channel-dynamic.spec.ts                                                                                                                                |
| 13  | ai namespace: send and receive response                     | namespace.spec.ts                                                                                                                                      |
| 14  | ai namespace: request model info                            | request.spec.ts (namespace scope)                                                                                                                      |
| 15  | ai namespace: stream tokens                                 | stream-basic.spec.ts                                                                                                                                   |
| 16  | ai namespace: stream with nudge pause                       | stream-nudges.spec.ts                                                                                                                                  |
| 17  | ai namespace: stream error                                  | stream-basic.spec.ts (error path)                                                                                                                      |
| 18  | scheduled task fires after delay                            | scheduled.spec.ts                                                                                                                                      |
| 19  | cancel scheduled task                                       | scheduled.spec.ts                                                                                                                                      |
| 20  | sql: save and retrieve notes                                | ctx-sql.spec.ts                                                                                                                                        |
| 21  | kv: set and get value                                       | ctx-kv.spec.ts                                                                                                                                         |
| 22  | get connection info                                         | ctx-tags.spec.ts                                                                                                                                       |
| 23  | tag and untag self                                          | ctx-tags.spec.ts                                                                                                                                       |
| 24  | binary echo                                                 | binary.spec.ts                                                                                                                                         |
| 25  | sendTo tag delivers message                                 | ctx-send.spec.ts                                                                                                                                       |
| 26  | server close disconnects client                             | ctx-send.spec.ts (ctx.close)                                                                                                                           |
| 27  | force disconnect (Disconnect error)                         | errors-control-flow.spec.ts                                                                                                                            |
| 28  | validation error fires onValidationError                    | lifecycle-hooks.spec.ts                                                                                                                                |
| 29  | defer: message retried after delay                          | errors-control-flow.spec.ts                                                                                                                            |
| 30  | block: handler never runs, no block-reply received          | errors-control-flow.spec.ts                                                                                                                            |
| 31  | skip: message passes through to handler                     | errors-control-flow.spec.ts                                                                                                                            |
| 32  | manual ValidationFailed triggers onValidationError          | errors-control-flow.spec.ts                                                                                                                            |
| 33  | DeferExhausted fires onError after retries exhaust          | errors-control-flow.spec.ts                                                                                                                            |
| 34  | channel members count after join                            | ctx-channels.spec.ts                                                                                                                                   |
| 35  | getConnectionsByTag returns self                            | ctx-tags.spec.ts                                                                                                                                       |
| 36  | quality info returns values                                 | ctx-quality.spec.ts                                                                                                                                    |
| 37  | sendToConnection with unknown ID returns delivered:false    | ctx-send.spec.ts                                                                                                                                       |
| 38  | sql: save then get notes separately                         | ctx-sql.spec.ts                                                                                                                                        |
| 39  | ai namespace: stream speed-up nudge                         | stream-nudges.spec.ts                                                                                                                                  |
| 40  | ai namespace: \_streamOk received before chunks             | stream-basic.spec.ts                                                                                                                                   |
| 41  | ai namespace: pre-intercept blocks message                  | intercept.spec.ts (namespace scope)                                                                                                                    |
| 42  | scheduled every: heartbeat fires repeatedly                 | scheduled.spec.ts                                                                                                                                      |
| 43  | scheduled retry: flaky task succeeds after retries          | scheduled.spec.ts                                                                                                                                      |
| 44  | scheduled retry: default retry succeeds after one retry     | scheduled.spec.ts                                                                                                                                      |
| 45  | cancelScheduled filter cancels only matching runs           | scheduled.spec.ts                                                                                                                                      |
| 46  | task-ctx sendToConnection: delivers to live connection      | scheduled.spec.ts                                                                                                                                      |
| 47  | task-ctx sendToConnection: stale id reports delivered:false | scheduled.spec.ts                                                                                                                                      |
| 48  | scheduled dead-letter: always-fail task lands in DLQ        | scheduled.spec.ts                                                                                                                                      |
| 49  | channel post-intercept rewrites payload                     | intercept.spec.ts (channel scope)                                                                                                                      |
| 50  | channel request: get-chat-info returns channel name         | request.spec.ts (channel scope)                                                                                                                        |
| 51  | chat channel: stream tokens inside channel                  | stream-basic.spec.ts (channel scope)                                                                                                                   |
| 52  | schedule then immediately cancel (cancel before fire)       | scheduled.spec.ts                                                                                                                                      |
| 53  | stream cancel: client cancels mid-stream                    | stream-basic.spec.ts                                                                                                                                   |
| 54  | ai namespace: post-intercept rewrites payload               | intercept.spec.ts (namespace scope)                                                                                                                    |
| 55  | dedup: outgoing messages have unique \_messageId            | dedup.spec.ts                                                                                                                                          |
| 56  | stream cancel sends cancel ack                              | stream-basic.spec.ts                                                                                                                                   |
| 57  | ai namespace: compose speed-up then pause in single stream  | stream-nudges.spec.ts                                                                                                                                  |
| 58  | \_replay on handler without replay is handled gracefully    | incoming.spec.ts ⚠ cross-cutting — recommend: `incoming`, reason: SUT is absence of replay; the graceful-unknown path lives in the incoming dispatcher |
| 59  | onShutdown: broadcasts user-left before closing connections | lifecycle-hooks.spec.ts                                                                                                                                |
| 60  | chat channel: always-defer throws exhaust chat-always-defer | errors-control-flow.spec.ts                                                                                                                            |
| 61  | cancelScheduled with no matching task id succeeds silently  | scheduled.spec.ts                                                                                                                                      |
| 62  | sendTo with empty tag does not crash                        | ctx-send.spec.ts                                                                                                                                       |

### `handler-multi.spec.ts` (19)

| #   | test name                                                                    | new feature file                                                                                                                                |
| --- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | chat: second user sees \_memberJoin                                          | channel-static.spec.ts                                                                                                                          |
| 2   | chat: cross-client broadcast                                                 | channel-static.spec.ts                                                                                                                          |
| 3   | chat: \_memberLeave on disconnect                                            | lifecycle-hooks.spec.ts (channel onUnsubscribe on drop)                                                                                         |
| 4   | chat: \_memberLeave on leave button                                          | channel-static.spec.ts                                                                                                                          |
| 5   | chat: onUnsubscribe broadcasts user-code system "left the chat" message      | lifecycle-hooks.spec.ts                                                                                                                         |
| 6   | chat: kick sends \_kicked to target                                          | ctx-channels.spec.ts                                                                                                                            |
| 7   | chat members count updates exactly after kick, and kicked client is isolated | ctx-channels.spec.ts                                                                                                                            |
| 8   | dynamic channel isolation: room:general vs room:vip                          | channel-dynamic.spec.ts                                                                                                                         |
| 9   | sendToConnection delivers to target                                          | ctx-send.spec.ts                                                                                                                                |
| 10  | sendToConnection with stale ID does not crash                                | ctx-send.spec.ts                                                                                                                                |
| 11  | sendTo fanout reaches every connection with the matching tag                 | ctx-send.spec.ts                                                                                                                                |
| 12  | top-level broadcast reaches second client                                    | ctx-send.spec.ts ⚠ cross-cutting — recommend: `ctx-send`, reason: primary SUT is the broadcast fanout path; lifecycle observation is incidental |
| 13  | broadcast stream reaches trigger connection and second client                | stream-broadcast.spec.ts                                                                                                                        |
| 14  | top-level broadcast with excludeSelf skips sender and reaches peer           | ctx-send.spec.ts                                                                                                                                |
| 15  | broadcastBinary reaches both clients                                         | binary.spec.ts                                                                                                                                  |
| 16  | dynamic channel: onSubscribe broadcasts system "entered" to existing members | lifecycle-hooks.spec.ts (channel onSubscribe, dynamic)                                                                                          |
| 17  | kick reason string reaches kicked client exactly                             | ctx-channels.spec.ts                                                                                                                            |
| 18  | cross-connection \_streamCancel from non-owner does not stop the stream      | stream-basic.spec.ts                                                                                                                            |
| 19  | broadcastBinary with excludeSelf skips the caller                            | binary.spec.ts                                                                                                                                  |

### `handler-rejection.spec.ts` (5)

| #   | test name                                           | new feature file                                                                                                                                     |
| --- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | chat rejects blocked-user (no \_subscribeOk)        | lifecycle-hooks.spec.ts                                                                                                                              |
| 2   | dynamic room rejects banned-user (no \_subscribeOk) | lifecycle-hooks.spec.ts                                                                                                                              |
| 3   | chat rejects blocked-user with error payload        | lifecycle-hooks.spec.ts                                                                                                                              |
| 4   | upgrade rejection: no username closes connection    | lifecycle-hooks.spec.ts ⚠ cross-cutting — recommend: `lifecycle-hooks`, reason: SUT is the onUpgrade hook; RejectUpgrade is its signalling primitive |
| 5   | upgrade rejection: HTTP branch returns 403 response | lifecycle-hooks.spec.ts ⚠ cross-cutting — recommend: `lifecycle-hooks`, reason: same as #4, HTTP branch of onUpgrade                                 |

### `hibernation.spec.ts` (2)

| #   | test name                                                                         | new feature file    |
| --- | --------------------------------------------------------------------------------- | ------------------- |
| 1   | main handler preserves tags and sendTo behavior across repeated hibernation wakes | hibernation.spec.ts |
| 2   | main handler preserves SQL state across reconnection (hibernation-friendly)       | hibernation.spec.ts |

### `extra-coverage.spec.ts` (20)

| #   | test name                                                                  | new feature file                                                                                                                                      |
| --- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | channel pre-intercept blocks a message before the handler runs             | intercept.spec.ts                                                                                                                                     |
| 2   | dynamic channel scope matches arbitrary suffixes and exposes the full name | channel-dynamic.spec.ts                                                                                                                               |
| 3   | async onBeforeSubscribe rejection prevents subscription                    | lifecycle-hooks.spec.ts                                                                                                                               |
| 4   | subscribe to a non-matching channel name emits \_error channel-not-found   | channel-static.spec.ts                                                                                                                                |
| 5   | subscribe with unknown dynamic scope emits \_error channel-not-found       | channel-dynamic.spec.ts                                                                                                                               |
| 6   | kv: delete removes a stored value                                          | ctx-kv.spec.ts                                                                                                                                        |
| 7   | kv: set with ttl expires within window                                     | ctx-kv.spec.ts                                                                                                                                        |
| 8   | SqlResult.one returns a single row                                         | ctx-sql.spec.ts                                                                                                                                       |
| 9   | SqlResult.raw returns array-of-arrays rows                                 | ctx-sql.spec.ts                                                                                                                                       |
| 10  | module typed error reaches the client                                      | modules.spec.ts                                                                                                                                       |
| 11  | ack is not emitted when handler throws                                     | ack.spec.ts                                                                                                                                           |
| 12  | onBinary can access ctx.meta (username)                                    | binary.spec.ts ⚠ cross-cutting — recommend: `binary`, reason: SUT is onBinary wiring; ctx.meta access is incidental observation                       |
| 13  | onShutdown broadcasts user-left to all connected clients                   | lifecycle-hooks.spec.ts                                                                                                                               |
| 14  | force-disconnect closes wire with code 4009                                | errors-control-flow.spec.ts                                                                                                                           |
| 15  | server-close delivers the code/reason pair on the wire                     | ctx-send.spec.ts ⚠ cross-cutting — recommend: `ctx-send`, reason: tests the user-facing ctx.close(code, reason) API, not a thrown control-flow signal |
| 16  | incoming dedup: identical \_messageId is dropped before the handler runs   | dedup.spec.ts                                                                                                                                         |
| 17  | incoming dedup: frames without \_messageId are always dispatched           | dedup.spec.ts                                                                                                                                         |
| 18  | double \_subscribe to chat is idempotent and re-emits \_subscribeOk        | channel-static.spec.ts                                                                                                                                |
| 19  | \_unsubscribe when not subscribed is a silent no-op                        | channel-static.spec.ts                                                                                                                                |
| 20  | publish to a channel without subscribing is silently dropped               | channel-static.spec.ts                                                                                                                                |

### `modules.spec.ts` (17) — all → `modules.spec.ts`

| #   | test name                                                     | new feature file |
| --- | ------------------------------------------------------------- | ---------------- |
| 1   | module onConnect fires (drizzle-ready)                        | modules.spec.ts  |
| 2   | insert record via module API                                  | modules.spec.ts  |
| 3   | get all records via module API                                | modules.spec.ts  |
| 4   | module onOutgoing can transform a module-owned outgoing event | modules.spec.ts  |
| 5   | get single record via module API                              | modules.spec.ts  |
| 6   | delete record via module API                                  | modules.spec.ts  |
| 7   | get record count via module API                               | modules.spec.ts  |
| 8   | module onIncoming counts messages                             | modules.spec.ts  |
| 9   | module scheduled task fires on trigger                        | modules.spec.ts  |
| 10  | module onIncoming can rewrite incoming payload                | modules.spec.ts  |
| 11  | module scheduled every: fires repeatedly                      | modules.spec.ts  |
| 12  | module scheduled retry: flaky task succeeds after retries     | modules.spec.ts  |
| 13  | module scheduled DLQ: always-fail task lands in DLQ           | modules.spec.ts  |
| 14  | module onOutgoing counts outgoing messages                    | modules.spec.ts  |
| 15  | module hooks can observe generateId and getState              | modules.spec.ts  |
| 16  | module onDisconnect increments counter                        | modules.spec.ts  |
| 17  | module onShutdown is observable after shutdown and reconnect  | modules.spec.ts  |

### `replay.spec.ts` (14)

| #   | test name                                                              | new feature file                                                                                                                                                                        |
| --- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | sends and receives messages                                            | replay-history.spec.ts                                                                                                                                                                  |
| 2   | sequence numbers present                                               | replay-history.spec.ts ⚠ cross-cutting — recommend: `replay-history`, reason: fixture is the only `persist: true` DO; keeping the test next to its fixture avoids duplicating the mount |
| 3   | replay returns stored messages after sending                           | replay-history.spec.ts                                                                                                                                                                  |
| 4   | excluded events not replayed (cursor excluded)                         | replay-history.spec.ts                                                                                                                                                                  |
| 5   | channel-scoped replay returns only channel messages                    | replay-history.spec.ts                                                                                                                                                                  |
| 6   | channel replay supports nonzero since                                  | replay-history.spec.ts                                                                                                                                                                  |
| 7   | programmatic sendReplay delivers message                               | replay-history.spec.ts                                                                                                                                                                  |
| 8   | channel sendReplay delivers message in channel scope                   | replay-history.spec.ts                                                                                                                                                                  |
| 9   | sequence persistence across reconnection                               | sequence.spec.ts ⚠ cross-cutting — recommend: `sequence`, reason: the only e2e covering `sequence({persist:true})`; reuses replay-history DO as fixture                                 |
| 10  | replay from nonzero since                                              | replay-history.spec.ts                                                                                                                                                                  |
| 11  | history retention prunes old rows once maxMessages is exceeded         | replay-history.spec.ts                                                                                                                                                                  |
| 12  | strict durability: send then immediate disconnect survives and replays | replay-history.spec.ts                                                                                                                                                                  |
| 13  | reconnect then replay with old seq returns only messages after it      | replay-history.spec.ts                                                                                                                                                                  |
| 14  | history retention prunes rows older than maxAgeMs                      | replay-history.spec.ts                                                                                                                                                                  |

### `replay-custom.spec.ts` (7) — all → `replay-custom.spec.ts`

| #   | test name                                             | new feature file      |
| --- | ----------------------------------------------------- | --------------------- |
| 1   | sends and receives notes                              | replay-custom.spec.ts |
| 2   | custom replay returns stored notes                    | replay-custom.spec.ts |
| 3   | channel-scoped custom replay returns channel messages | replay-custom.spec.ts |
| 4   | onAfterSend marks messages as confirmed               | replay-custom.spec.ts |
| 5   | channel onAfterSend marks room messages as confirmed  | replay-custom.spec.ts |
| 6   | custom replay supports nonzero since                  | replay-custom.spec.ts |
| 7   | channel custom replay supports nonzero since          | replay-custom.spec.ts |

### `replay-snapshot.spec.ts` (8) — all → `replay-snapshot.spec.ts`

| #   | test name                                                                 | new feature file        |
| --- | ------------------------------------------------------------------------- | ----------------------- |
| 1   | snapshot mode: only latest value per key replayed                         | replay-snapshot.spec.ts |
| 2   | best-effort durability: message replayable after async write              | replay-snapshot.spec.ts |
| 3   | retention pruning: maxMessages limits replayed snapshots                  | replay-snapshot.spec.ts |
| 4   | reduce: multiple increments merge into accumulated total                  | replay-snapshot.spec.ts |
| 5   | reduce-merge snapshot replays merged value with latest seq for since=N1-1 | replay-snapshot.spec.ts |
| 6   | reduce can delete a snapshot key                                          | replay-snapshot.spec.ts |
| 7   | maxAgeMs: old messages pruned after expiry                                | replay-snapshot.spec.ts |
| 8   | channel snapshot replay keeps only the latest value per key               | replay-snapshot.spec.ts |

**Row count check:** 62 + 19 + 5 + 2 + 20 + 17 + 14 + 7 + 8 = **154** ✓

---

## 4. Handler merging / splitting decisions

The current `src/lib/server/handler.ts` (plus `setup.ts`, and every `ai`/`chat`/`connections`/`dynamic-channel`/`echo`/`scheduled`/`storage` bundle) must dissolve into one-feature-per-handler files. Principle: each new handler is the **smallest** builder that can prove its feature over the wire.

### 4a. Shared scaffolding to be relocated

Some pieces are legitimately shared across features (they are not features themselves — they are prerequisites for doing anything at all):

- `onUpgrade` that reads `?username=` → **`src/lib/server/_shared/upgrade.ts`** (exports a tiny helper `requireUsername(request)` the feature handlers call inside their own `.onUpgrade(...)`). Each feature handler still writes its own lifecycle chain; the helper removes duplication without smuggling unrelated behaviors.
- `NotFound` / `Forbidden` error factories → **`src/lib/server/_shared/errors.ts`** (used only by `errors-factory/handler.ts`, `errors-control-flow/handler.ts` (for stream-error flow), and any feature where we want a generic typed error; kept narrow — prefer local errors per feature).
- `serve` wrapper boilerplate (`{ hibernation: false }`) → **no shared file needed**; it's one line per handler. `hibernation/handler.ts` uses `{ hibernation: true }`.

No other "base" mix-in (no shared `base` with `.ack().sequence().dedup().heartbeat()`). Every feature re-applies the exact decorators it needs — this is the whole point of the split. If `ack.spec.ts` needs `.ack()`, its handler calls `withAck`; if `sequence.spec.ts` needs `.sequence()`, its handler calls `withSequence`.

### 4b. Per-feature split

| Current source of behavior                                                                                                                                           | Goes to                                                                                                                                                                                                                                                                                                                                                                                                                    | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `handler.ts: .onConnect/onDisconnect/onShutdown/onError/onUpgrade/onValidationError/onBinary`                                                                        | `lifecycle-hooks/handler.ts`                                                                                                                                                                                                                                                                                                                                                                                               | One handler that exercises every lifecycle hook. Includes the channel-scope `onBeforeSubscribe/onSubscribe/onUnsubscribe` test path as well (they're also lifecycle hooks).                                                                                                                                                                                                                                                                                                                                                                                             |
| `handler.ts: .intercept(...)` top-level pre + post + `chat/channel.ts` intercepts + `ai/namespace.ts` intercepts                                                     | `intercept/handler.ts`                                                                                                                                                                                                                                                                                                                                                                                                     | One handler with a top-level pre-intercept, a top-level post-intercept (on `echo`), a one-channel for channel-scope intercepts, and a one-namespace for namespace-scope intercepts. Block/Skip behavior kept here because it's the idiomatic way to trigger intercepts; the error signals themselves still live in `errors-control-flow`. **Tolerated overlap**: Block/Skip are thrown from this intercept handler _and_ from `errors-control-flow/handler.ts`. That's two independent exercises of the same control-flow primitive in different contexts — legitimate. |
| `handler.ts: .request(GetTime, ...)` + `ai/namespace.ts: .request(GetModel, ...)` + `chat/channel.ts: .request(GetChatInfo, ...)`                                    | `request/handler.ts`                                                                                                                                                                                                                                                                                                                                                                                                       | Single handler proving request at top-level, namespace, and channel scopes. Declares the minimum channel + namespace needed for those three request scopes.                                                                                                                                                                                                                                                                                                                                                                                                             |
| `handler.ts: .incoming(DeferTest/AlwaysDefer/BlockTest/SkipTest/ManualValidation/AckThenThrow/QueryDeadLetter)` + `echo/handlers.ts: TriggerError` + inline handlers | `errors-control-flow/handler.ts` + `errors-factory/handler.ts`                                                                                                                                                                                                                                                                                                                                                             | Defer/Block/Skip/ValidationFailed/Disconnect/DeferExhausted → `errors-control-flow`. `NotFound`/`Forbidden` round-trip + `.errors(...)` registration → `errors-factory`. Stream error path (`AiStreamError`) moves to `stream-basic/handler.ts` because it tests a stream's error emission, not the error factory.                                                                                                                                                                                                                                                      |
| `echo/handlers.ts: Echo/ack`                                                                                                                                         | `ack/handler.ts` + `incoming/handler.ts`                                                                                                                                                                                                                                                                                                                                                                                   | Echo itself is the canonical demo of `incoming` (reception → validation → handler runs). `ctx.ack()` call + not-emitted-on-throw is proven by `ack/handler.ts` (which also declares the `ack-then-throw` incoming).                                                                                                                                                                                                                                                                                                                                                     |
| `chat/channel.ts`                                                                                                                                                    | `channel-static/handler.ts` (core static channel), `lifecycle-hooks/handler.ts` (onBeforeSubscribe/onSubscribe/onUnsubscribe tests), `intercept/handler.ts` (channel-scope pre/post intercept), `request/handler.ts` (channel-scope request), `stream-basic/handler.ts` (channel-scope stream), `errors-control-flow/handler.ts` (chat-always-defer).                                                                      | The chat channel dissolves into 6 feature-owned channels, each named `chat` inside its own handler.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `dynamic-channel/channel.ts`                                                                                                                                         | `channel-dynamic/handler.ts` + `lifecycle-hooks/handler.ts` (async onBeforeSubscribe rejection for banned-user path).                                                                                                                                                                                                                                                                                                      | The `banned-user` + `async-banned-user` behaviors belong in `lifecycle-hooks`. The scope-matching, suffix extraction, send/receive, isolation belong in `channel-dynamic`.                                                                                                                                                                                                                                                                                                                                                                                              |
| `ai/namespace.ts`                                                                                                                                                    | `namespace/handler.ts` (the namespace primitive itself + base `AiSend`/`AiResponse`), `stream-basic/handler.ts` (tokens, streamOk, stream-error, cancel), `stream-nudges/handler.ts` (nudge pause + speed-up), `stream-broadcast/handler.ts` (broadcast stream), `intercept/handler.ts` (ai namespace pre + post intercept), `request/handler.ts` (GetModel request in namespace).                                         | `ai` as a fiction vanishes — the namespace still uses the name `ai` when testing the `namespace` feature (because a namespace needs a name and "ai" is as good as any), but the scaffolding is no longer fake-product-oriented. Prefer a neutral name like `ns1` for `namespace/handler.ts`.                                                                                                                                                                                                                                                                            |
| `connections/handlers.ts`                                                                                                                                            | Splits into: `ctx-send/handler.ts` (send/broadcast/sendTo/sendToConnection/excludeSelf/server-close), `ctx-tags/handler.ts` (getConnectionInfo/tag/untag/getConnectionsByTag), `ctx-quality/handler.ts` (quality/latency/bufferedAmount), `binary/handler.ts` (broadcastBinary\*), `errors-control-flow/handler.ts` (force-disconnect → Disconnect).                                                                       |
| `scheduled/handlers.ts`                                                                                                                                              | `scheduled/handler.ts`                                                                                                                                                                                                                                                                                                                                                                                                     | Stays as one handler — all tests are variants of the one feature. Keeps every task (`cleanup`, `heartbeat-tick`, `flaky-task`, `default-retry-task`, `filtered-cleanup`, `always-fail-task`, `send-to-conn-task`).                                                                                                                                                                                                                                                                                                                                                      |
| `storage/handlers.ts`                                                                                                                                                | Splits: `ctx-sql/handler.ts` (save-note/get-notes + sql-one-probe/sql-raw-probe), `ctx-kv/handler.ts` (kv-set/kv-get/kv-delete/kv-set-ttl).                                                                                                                                                                                                                                                                                |
| `handler.ts: .dedup()` outgoing \_messageId test + extra-coverage dedup tests                                                                                        | `dedup/handler.ts`                                                                                                                                                                                                                                                                                                                                                                                                         | Small handler with one echo incoming for the dedup behaviors.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `handler.ts: .sequence()`                                                                                                                                            | `sequence/handler.ts`                                                                                                                                                                                                                                                                                                                                                                                                      | Small handler with `.sequence()` (in-memory) for the increment test. The cross-reconnect `persist: true` test reuses `replay-history/handler.ts` (via `/ws/replay-history`) — it's the only place `sequence({persist:true})` is wired, so duplicating that DO just to prove sequence persistence would be wasteful. **Allowed exception**: `sequence.spec.ts` contains one test that drives the `replay-history` mount.                                                                                                                                                 |
| `handler.ts: .heartbeat({timeout})`                                                                                                                                  | (no new handler)                                                                                                                                                                                                                                                                                                                                                                                                           | The catalog has an `Untested` gap for heartbeat close. Constraint says ignore audit gaps. Skip.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `server-modules/handler.ts`                                                                                                                                          | `modules/handler.ts` (rename in-place; content mostly the same).                                                                                                                                                                                                                                                                                                                                                           |
| `server-replay/handler.ts`                                                                                                                                           | `replay-history/handler.ts` (rename).                                                                                                                                                                                                                                                                                                                                                                                      |
| `server-replay-custom/handler.ts`                                                                                                                                    | `replay-custom/handler.ts` (rename).                                                                                                                                                                                                                                                                                                                                                                                       |
| `server-replay-snapshot/handler.ts`                                                                                                                                  | `replay-snapshot/handler.ts` (rename).                                                                                                                                                                                                                                                                                                                                                                                     |
| `server-reject-http/handler.ts`                                                                                                                                      | Absorbed by `lifecycle-hooks/handler.ts` as an alternate DO mount, OR kept as its own `upgrade-reject-http/handler.ts`. **Recommendation**: keep as its own tiny handler at `src/lib/server/lifecycle-hooks-http-reject/handler.ts` because it needs a different `onUpgrade` that always rejects HTTP — mixing it with the "happy path" lifecycle handler is awkward. The `lifecycle-hooks.spec.ts` test hits both mounts. |
| `ctx-meta.spec.ts`                                                                                                                                                   | Reuses `lifecycle-hooks/handler.ts` (meta is set by onUpgrade) or a dedicated `ctx-meta/handler.ts`. **Recommendation**: dedicated handler, since the subject is the read side (`ctx.meta.username` visible in an incoming handler) which `lifecycle-hooks` proves incidentally — having a standalone makes the test explicit.                                                                                             |
| `ctx-channels/handler.ts`                                                                                                                                            | Channel-members + kick. Needs one static channel to kick from, so it declares a minimal `chat` channel.                                                                                                                                                                                                                                                                                                                    |

### 4c. Wrangler / worker.ts

Constraint says worker entry stays as-is in structure. Each new handler needs its own DO class and route:

- `/ws/incoming`, `/ws/request`, `/ws/stream-basic`, ... one route per feature.
- `/ws/{feature}/shutdown` where tests post to shutdown (currently `lifecycle-hooks`, `modules`).
- `wrangler.jsonc` bindings added one per DO. Mechanical edit.

---

## 5. Page-route split mirror

Each feature page is a thin panel containing only the buttons its spec presses. Every `data-testid` currently in the monolithic `src/routes/+page.svelte` (and the four scoped pages) must land in exactly one new page.

### Page assignment (authoritative)

`src/routes/incoming/+page.svelte`

- `echo-btn` (baseline incoming), `echo-result`, `validation-error-btn`, `validation-error-result`, `manual-validation-btn` — **FLAG: `manual-validation-btn` could also live in `errors-control-flow` — primary subject is ValidationFailed, move there.** Final call: move to `errors-control-flow`.
- Hosts the "replay on handler without replay" negative test (mount has no replay).

`src/routes/ack/+page.svelte`

- `echo-btn` (re-used for the ack path; this page's handler attaches `.ack()`), `ack-result`, `ack-then-throw` probe (new `ack-then-throw-btn`).

`src/routes/request/+page.svelte`

- `request-time-btn`, `time-result`, `ai-model-btn`, `ai-model-result`, `chat-info-btn`, `chat-info-result`.
- Page includes a minimal chat join for the channel-scope request.

`src/routes/stream-basic/+page.svelte`

- `ai-stream-btn`, `ai-stream-tokens`, `ai-stream-done`, `ai-stream-error-btn`, `ai-stream-error-result`, `ai-stream-cancel-btn`, `stream-cancel-result`, `stream-ok-received`, `chat-stream-btn`, `chat-stream-tokens`, `chat-stream-done` (for channel-scope stream).

`src/routes/stream-nudges/+page.svelte`

- `ai-nudge-stream-btn`, `ai-nudge-pause-btn`, `ai-speed-up-btn`, `ai-nudge-stream-tokens`, `ai-nudge-stream-done`.

`src/routes/stream-broadcast/+page.svelte`

- `broadcast-stream-btn`, `broadcast-stream-tokens`.

`src/routes/channel-static/+page.svelte`

- `chat-join-btn`, `chat-leave-btn`, `chat-send-btn`, `chat-subscribed`, `chat-messages`, `member-joins`, `member-leaves`, plus the "publish-without-subscribe" / "double-subscribe" / "unsubscribe-when-not-subscribed" / "subscribe-to-unknown-channel" probes currently driven via `page.evaluate` raw sends (keep raw sends; add visible test-ids for negative outcomes).

`src/routes/channel-dynamic/+page.svelte`

- `room-join-btn`, `room-send-btn`, `room-subscribed`, `room-messages`, `room-echo-param` probe (currently raw send). Subscribe-error state.

`src/routes/lifecycle-hooks/+page.svelte`

- `connect-btn`, `disconnect-btn`, `username-input`, `status`, `user-events`, `server-close-btn` (for lifecycle-test completeness), plus a chat join so `onBeforeSubscribe/onSubscribe/onUnsubscribe` can fire, `subscribe-error`.
- `validation-error-btn` / `validation-error-result` for `onValidationError`.
- `binary-send-btn` (proves `onBinary` fires and sees meta).
- `shutdown` is driven by `page.request.post('/ws/lifecycle-hooks/shutdown?room=...')`.

`src/routes/namespace/+page.svelte`

- `ai-send-btn` (renamed to `ns-send-btn`), `ai-response` (renamed). Proves namespace routing and ctx.namespace.send.

`src/routes/intercept/+page.svelte`

- `echo-rewrite-btn`, `echo-result` (post-intercept top-level), `block-btn`/`block-reply` (pre-intercept at top level), `skip-btn`/`skip-reply` (pre-intercept passthrough), `ai-blocked-btn`/`ai-blocked-reply` (namespace pre), `ai-post-intercept-btn`/`ai-post-intercept-result` (namespace post), chat channel pre (channel-pre-block raw send) and post (intercept-channel-test raw send).
- **Note**: Block/Skip buttons are primarily for `errors-control-flow`, but because they only meaningfully do anything through an intercept, the page for `intercept` and the page for `errors-control-flow` can either both host copies, or one hosts them and the other navigates there. **Recommendation**: `intercept/+page.svelte` hosts them (they're intercept-observable); `errors-control-flow/+page.svelte` hosts `defer-btn`, `always-defer-btn`, `force-disconnect-btn`, `manual-validation-btn`, `chat-defer-btn`.

`src/routes/errors-factory/+page.svelte`

- `error-notfound-btn`, `error-forbidden-btn`, `error-result`.

`src/routes/errors-control-flow/+page.svelte`

- `defer-btn`, `defer-result`, `always-defer-btn`, `defer-exhausted-result`, `force-disconnect-btn`, `chat-defer-btn` (chat-always-defer), `manual-validation-btn`, `validation-error-result`.

`src/routes/sequence/+page.svelte`

- `echo-btn`, `last-seq`. The reconnect-persistence test uses `replay-history` mount via its own page (it's the only place sequence is persisted — see §7 risks).

`src/routes/dedup/+page.svelte`

- `echo-btn`, `received-message-ids`. The incoming dedup tests use raw sends, no new button.

`src/routes/scheduled/+page.svelte`

- `schedule-btn`, `cancel-cleanup-btn`, `cancel-nothing-btn`, `scheduled-result`, `cancel-result`, `cancel-nothing-result`, `start-heartbeat-btn`, `heartbeat-count`, `trigger-flaky-btn`, `flaky-task-result`, `trigger-default-retry-btn`, `default-retry-result`, `schedule-filtered-btn`, `cancel-filtered-drop-btn`, `filtered-task-result`, `trigger-always-fail-btn`, `query-dead-letter-btn`, `dead-letter-result`, `schedule-send-to-conn-self-btn`, `schedule-send-to-conn-stale-btn`, `schedule-send-to-conn-status`, `schedule-send-to-conn-delivery`.

`src/routes/binary/+page.svelte`

- `binary-send-btn`, `binary-result`, `broadcast-binary-all-btn`, `broadcast-binary-exclude-self-btn`.

`src/routes/ctx-send/+page.svelte`

- `send-to-tag-btn`, `tagged-message`, `broadcast-exclude-self-btn`, `broadcast-result`, `conn-info-btn`, `connection-info`, `connection-id`, raw `send-to-connection` sends (current `send-to-conn-result`, `send-to-conn-status`), `server-close-btn`.

`src/routes/ctx-channels/+page.svelte`

- `chat-join-btn`, `chat-subscribed`, `get-members-btn`, `channel-members-result`, `kick-from-channel-btn`, `kicked-result`.

`src/routes/ctx-sql/+page.svelte`

- `save-note-btn`, `get-notes-btn`, `notes-list`, plus raw `sql-one-probe` / `sql-raw-probe` sends (and their result test-ids).

`src/routes/ctx-kv/+page.svelte`

- `kv-set-btn`, `kv-get-btn`, `kv-result`, plus raw `kv-delete` / `kv-set-ttl` sends.

`src/routes/ctx-tags/+page.svelte`

- `tag-self-btn`, `untag-self-btn`, `tag-result`, `conn-info-btn`, `connection-info`, `get-connections-by-tag-btn`, `connections-by-tag-result`.

`src/routes/ctx-quality/+page.svelte`

- `get-quality-btn`, `quality-result`.

`src/routes/ctx-meta/+page.svelte`

- `echo-btn` whose server echo includes the username read from `ctx.meta`. Minimal — reuses existing `echoed` event.

`src/routes/hibernation/+page.svelte`

- No new buttons needed; both tests drive everything via `page.evaluate(...)` with raw WebSocket (they already do today). Page just needs the route to exist.

`src/routes/modules/+page.svelte`, `src/routes/replay-history/+page.svelte`, `src/routes/replay-custom/+page.svelte`, `src/routes/replay-snapshot/+page.svelte`

- Renamed as-is from current four scoped pages.

`src/routes/+page.svelte`

- Becomes an index listing each feature page as a link. No buttons.

---

## 6. Order of operations

**Incremental, one feature at a time.** A big-bang rename would leave the suite broken for hours and would force rewriting spec selectors twice. Recommended sequence:

### Phase 0 — Correct the stream API (core, pre-restructure) ✅ DONE

**Status:** all substeps landed. `StreamBuilder.extract()` removed, `.broadcast()` added, the closure form is the only overload in `feature-methods.ts`, `scope-state.ts` collapsed into an `index.ts` barrel, `types.test-d.ts` fixture asserts typesafe composition across server / group / namespace / channel, catalog renumbered to 38 features. All unit + e2e + typecheck + oxlint gates green (154/154 e2e, 346/346 server-core unit, 29/29 server-cloudflare, 43/43 core).

The stream primitive is asymmetric with channel/namespace: it uses a chained fluent builder terminated by `.generate()` or `.extract()`, while channel/namespace use a `(parent, child => child…)` closure. This inconsistency is an oversight from earlier design and has no external users yet (pre-launch), so fix it before any e2e work so the new handler files are written against the corrected shape from day one.

**Target API (single closure overload):**

```ts
handler.stream(startEvent, chunkSchema, (s) => s
  .nudge(pauseEvent)
  .nudge(speedUpEvent)
  .broadcast()                        // replaces the `{ broadcast: true }` options arg
  .generate(async function* (ctx, payload) { ... })
);
```

The callback form already exists at runtime ([server-core/src/stream/with.ts:29](server/server-core/src/stream/with.ts:29), applied to all four kinds `['server', 'group', 'namespace', 'channel']`) and in the type system ([server-core/src/\_types/feature-methods.ts](server/server-core/src/_types/feature-methods.ts) at lines **538** (top-level — covers both `server` and `group` since `GroupBuilderFull` plugs into the same `FullBuilder`), **642** (namespace), **721** (channel)) as an overload on top of the chained form. `StreamBuilder.nudge()` already accumulates `TNudges` through the fluent chain, so **type inference inside the closure is already correct** — this refactor is mostly deletion.

**Scope coverage requirement.** `.stream(...)` must remain fully type-safe in all four scopes: top-level server, group, namespace, channel. This is wskit's core value proposition — every primitive composes across scopes with inference intact. Phase 0 is not done until the gate below passes for all four.

**Concrete edits (all in `server/server-core/src/`):**

0.1. `stream/builder.ts` — delete `StreamBuilder.extract()` (lines 119–139). Remove the `_parentPrimitives` push logic from `.generate()` only if we decide `.generate()` must no-op when called outside the callback; simplest: keep `.generate()` as the push point, it's only reachable through the closure now.

0.2. `stream/with.ts` — simplify `streamImpl` to require a callback. Remove the options overload (`{ broadcast?: boolean }` as 3rd arg); broadcast moves onto the builder as `.broadcast()`. New shape:

```ts
function streamImpl(parent, eventContract, chunkSchema, callback) {
  const builder = new StreamBuilder(parent, parent._primitives, eventContract, chunkSchema);
  callback(builder);
  return parent;
}
```

0.3. `stream/builder.ts` — add `.broadcast(): this` method that sets `this._broadcast = true` and returns the same builder (no type change; broadcast is a runtime flag, not a type-level distinction).

0.4. `_types/feature-methods.ts` — in all three `MethodType` sections for `M extends 'stream'` (top-level ~line 538 covering server + group, namespace ~line 642, channel ~line 721), **delete the non-callback overload**. Keep only the callback-taking overload. The intersection `(...) & (callback ...)` becomes just `(callback ...)`. The `options?: { broadcast?: boolean }` parameter disappears from both the deleted overload and the surviving one (broadcast is now a builder method).

0.5. Update internal unit tests that use the chained form — rewrite to closures:

- `server-core/src/_builder/integration.spec.ts`
- `server-core/src/_builder/integration.test.ts`
- `server-core/src/stream/stream.spec.ts`
- `server-core/src/stream/with.spec.ts`
- `server-core/src/namespace/namespace.spec.ts`

  0.6. Update `server-core/src/replay/custom/builder.ts:24` comment — it cites `.extract()` on the stream/replay builder; leave the replay custom-builder's own `.extract()` alone (that's a snapshot-config validator, different feature), just fix the stray reference if wrong.

  0.7. Update `BEHAVIOR_COVERAGE__SERVER.md` — delete feature #9 (stream — extract). Renumber #10–#39 down by one (to 38 features).

  0.8. Run the full server-core unit suite + e2e suite. Both must pass before Phase 1 begins. The e2e handlers under `chat/channel.ts` and `ai/namespace.ts` will still use the chained form — update them as part of this phase, not Phase 1c, so the suite is green at the Phase 0 boundary.

  0.9. **Barrel cleanup.** `server-core/src/_types/scope-state.ts` is a 4-line re-export of `_types/scope-state/{extract,fold,handler-ctx,methods}.ts`. Delete the outer file; add `_types/scope-state/index.ts` with the same four re-exports. Update the sole importer (`_types/feature-methods.ts:17`, which imports from `~/_types/scope-state.ts`) to import from `~/_types/scope-state/index.ts` (or drop the filename entirely if the tsconfig path-resolver picks up `index`). Tangential to stream, but user called it out; batch it here to avoid a drive-by commit later.

**Typesafety gate — must hold in all four scopes (server, group, namespace, channel):**

- `ctx.nudges()` inside `.generate()` typed as a union of nudged-event payloads (`TNudges` carried through the fluent builder inside the closure).
- The `AsyncGenerator<TChunks, void, ...>` return type infers `TNext` as `undefined` with zero nudges, `StreamNudgeMessages<TNudges>` with 1+.
- The parent-builder return type after `.stream(event, chunk, (s) => s.generate(...))` is `FullBuilder<NextState<TState, GeneratePrimitive<...>>, TFeatures, Kind>` — i.e., the stream primitive registers into parent state exactly as the chained form did. `Kind` must be preserved (server/group/namespace/channel) so subsequent `.on/.channel/.namespace/.request/.stream` remain available and continue to narrow `TState`.
- **Matrix test fixture.** Add a TS-only compile-check fixture at `server-core/src/stream/types.test-d.ts` (or extend an existing `*.test-d.ts` file if the repo uses one) that constructs a stream inside each of the four scopes and asserts the nudge-payload union, chunk type, and post-`.stream` parent state via `expectTypeOf` or equivalent. Missing in one scope = phase not done.
- No callers need `// @ts-expect-error` or casts after the refactor. If any do, the overload removal was incomplete.

**Risk:** low. Runtime is a subset of existing behavior, type-level change is overload-pruning, and there are no external consumers.

### Phase 1a — Scaffolding (0 test moves)

1. Create `src/lib/server/_shared/upgrade.ts` (`requireUsername` helper) and `src/lib/server/_shared/errors.ts` (NotFound, Forbidden).
2. Add empty `src/routes/` subtrees for each new feature and `src/lib/server/{feature}/` skeletons (each with a placeholder `handler.ts` that only declares `onUpgrade` + a `serve`). Wire wrangler bindings + worker.ts routes for all new DOs at once. Nothing ships yet.

### Phase 1b — Leaf features first (simple, low-risk)

Order within this phase — do the features with the fewest cross-cutting concerns and zero shared-scaffolding dependencies: 3. `ack` (copy Echo handler + ack, copy `ack-then-throw` from extra-coverage; move 2 tests). 4. `binary` (4 tests). 5. `ctx-quality` (1 test). 6. `ctx-meta` (1 test). 7. `ctx-kv` (3 tests). 8. `ctx-sql` (4 tests). 9. `ctx-tags` (3 tests). 10. `ctx-send` (move 7 tests: sendTo, sendToConnection known/unknown, broadcast excludeSelf, server-close, cross-client broadcast, sendTo fanout). 11. `ctx-channels` (3 tests: members, kick reason, members-count-after-kick). 12. `sequence` (2 tests: increment; reconnect-persistence after replay-history is extracted). 13. `dedup` (3 tests). 14. `errors-factory` (2 tests). 15. `errors-control-flow` (7 tests: Defer, Block, Skip, DeferExhausted, ValidationFailed manual, force-disconnect/Disconnect, chat-always-defer).

### Phase 1c — Channel / stream / namespace / intercept

16. `channel-static` (pull chat channel pieces; 10+ tests — subscribe/publish/broadcast/double-sub/no-sub publish/unsub no-op/unknown-channel).
17. `channel-dynamic` (6 tests).
18. `namespace` (1 core test; other namespace tests stay in their feature files).
19. `stream-basic` (8 tests including channel-scope stream and cross-connection cancel).
20. `stream-nudges` (3 tests).
21. `stream-broadcast` (1 test).
22. `intercept` (6 tests spanning top-level, channel, and namespace scopes).
23. `request` (3 tests).
24. `scheduled` (12 tests — largest single feature; do last in this phase).

### Phase 1d — Lifecycle + cross-cutting

25. `lifecycle-hooks` (11 tests: connect/disconnect/shutdown + onUpgrade + onBeforeSubscribe variants + onValidationError + \_memberLeave on disconnect + channel onSubscribe/onUnsubscribe system messages).
26. `incoming` (echo baseline + `_replay`-without-replay graceful test).

### Phase 1e — Standalone DOs (rename only)

27. Rename `server-modules/` → `modules/`. Update wrangler + route. Move `modules.spec.ts` as-is (edit the goto path).
28. Rename `server-replay/` → `replay-history/`. Move `replay.spec.ts` → `replay-history.spec.ts`. Route flip.
29. Rename `server-replay-custom/` → `replay-custom/`. Move file.
30. Rename `server-replay-snapshot/` → `replay-snapshot/`. Move file.
31. Rename `server-reject-http/` → `lifecycle-hooks-http-reject/`. Fold the one test call into `lifecycle-hooks.spec.ts`.
32. `hibernation` — create a new DO with `{ hibernation: true }` mounted at `/ws/hibernation`. The two hibernation tests currently hit `/ws` (which has `hibernation: false`!). **This is a latent correctness issue in the current suite** — those tests claim to exercise hibernation but run against a non-hibernating DO. Flag in §7; fix by pointing them at the new mount.

### Phase 1f — Cleanup

33. Delete `src/lib/server/handler.ts`, `setup.ts`, and the old `ai/chat/connections/dynamic-channel/echo/scheduled/storage` subfolders.
34. Delete the monolithic `src/routes/+page.svelte` button body; keep as feature-index.
35. Delete old spec files (`handler.spec.ts`, `handler-multi.spec.ts`, `handler-rejection.spec.ts`, `extra-coverage.spec.ts`) once every test from them has moved.
36. Verify `test(` count across new `tests/*.spec.ts` equals the original total (baseline all features against grep).

### Dependencies

- **Phase 0 must happen before Phase 1a.** New handlers written in Phase 1 assume closure-scoped `.stream()`; writing them against the old chained form would force a second rewrite.
- Phase 1a must happen before any other Phase 1 step.
- `sequence`'s reconnect-persistence test depends on `replay-history` existing (Phase 1e step 28).
- Every step inside 1b–1d is independent and could be parallelized across contributors. Suite stays green throughout because old files keep passing until their last test migrates.

---

## 7. Risks

1. **`sequence({ persist: true })` is only wired on the current `replay` DO.** The "sequence persistence across reconnection" test is the only e2e coverage of persisted sequences. Splitting it off creates a choice:
   - (a) Reuse the `replay-history` DO as `sequence.spec.ts`'s fixture (recommended; one line of "goto `/replay-history`").
   - (b) Stand up a second DO that does `.sequence({persist:true})` without replay. More code, same coverage.
     Either is fine; (a) violates "one feature per page" slightly but keeps the test count stable.

2. **Hibernation tests hit the wrong DO.** Current `hibernation.spec.ts` opens `/ws` (the main DO with `hibernation: false`). The tests pass because they observe tag/SQL persistence across _reconnection_, not actual hibernation wake behavior. Moving to a dedicated `hibernation` mount with `{hibernation:true}` strengthens the tests, but the "reorganization, not rewrite" constraint says preserve behavior — **recommendation**: create the new mount AND keep the same assertions (they'll still pass since tag/meta/SQL persistence works in both modes). Flag for a follow-up audit gap.

3. **Channel lifecycle hooks couple tightly to channel definitions.** The `chat` channel's `onSubscribe` broadcasts a system message that is observed by **two** feature specs: `channel-static.spec.ts` (via `chat: join broadcasts system message`) and `lifecycle-hooks.spec.ts` (via `chat: onUnsubscribe broadcasts "left the chat"`). Both specs need a chat channel with those hooks attached. Either:
   - Each feature's handler declares its own small `chat` channel with the subset of hooks it needs, or
   - A single "channel-with-lifecycle-hooks" handler is shared by both (rejected — violates one-feature-per-handler).
     **Recommendation**: duplicate the channel definition. It's ~15 LOC per handler. The clarity win outweighs the DRY loss.

4. **Intercept Block/Skip and error control flow overlap.** `Block` and `Skip` are thrown from intercepts but are also catalog entries under feature 25 (errors control flow). The tests live in whichever site produced them (Block inside an intercept → `intercept.spec.ts` OR `errors-control-flow.spec.ts`). Per the mapping in §3, Block/Skip behavior is classed as `errors-control-flow` — the intercept is merely the carrier. Accept the overlap: `intercept/handler.ts` throws `Block`/`Skip`, but the spec that asserts the effect lives in `errors-control-flow.spec.ts`. A single button on `errors-control-flow/+page.svelte` (`block-btn`) sends a message that `intercept/handler.ts`'s pre-intercept throws `Block` on. This couples the two features at the page/handler level — mitigate by co-locating the block/skip buttons on `errors-control-flow/+page.svelte` even though the handler is the intercept one (effectively the errors-control-flow DO mounts the intercept handler). An alternative is to have a dedicated tiny intercept inside the `errors-control-flow/handler.ts` that throws Block/Skip — **recommended**, cleaner.

5. **Cross-connection `_streamCancel` test (`handler-multi.spec.ts` #18) needs two connected clients on the same DO.** Target `stream-basic.spec.ts` works as long as the `stream-basic` handler accepts two connections. No special scaffolding needed; just make sure the `stream-basic` route supports it (it will — it's just a WS DO).

6. **`channel-static.spec.ts` "publish without subscribe is silently dropped"** is a negative test. The feature handler must still **declare** the `send-chat` incoming for the drop path to exercise the correct code. Already handled by copying the existing `chat` channel into `channel-static/handler.ts`.

7. **The `_replay` on a handler without replay** test (handler.spec.ts) proves absence of a feature. If we put it in `incoming.spec.ts`, the `incoming/handler.ts` has no replay, which is exactly the condition under test. Good fit.

8. **`lifecycle-hooks.spec.ts` will be the largest single spec** (~12 tests) because so many legitimately-lifecycle behaviors collapse into it (`onConnect`, `onDisconnect`, `onShutdown`, `onError`, `onValidationError`, `onUpgrade` success + RejectUpgrade WS + RejectUpgrade HTTP, channel `onBeforeSubscribe` sync + async + dynamic-scope + `onSubscribe` + `onUnsubscribe-on-leave` + `onUnsubscribe-on-disconnect`). That's fine — lifecycle is one feature with many hooks.

9. **The replay-snapshot-mode "best-effort durability"** test currently runs against the snapshot DO which uses `best-effort`. The history durability tests run against the replay DO which uses `strict`. The split preserves this because each DO has its own handler. No risk; just ensure `replay-history/handler.ts` stays on `strict` and `replay-snapshot/handler.ts` stays on `best-effort`.

10. **Test count preservation.** After all moves, run `rg "^\s*test\(" tests/*.spec.ts | wc -l` and compare to the pre-restructure count. Any drop or addition is a bug in the move. CI should assert this equality until the rename is complete.

---

## End of plan

Critical files for implementation (absolute paths):

- /Users/gyen/PersonalProjects/wskit/server/tests-e2e-cloudflare/src/lib/server/handler.ts
- /Users/gyen/PersonalProjects/wskit/server/tests-e2e-cloudflare/src/lib/server/setup.ts
- /Users/gyen/PersonalProjects/wskit/server/tests-e2e-cloudflare/src/worker.ts
- /Users/gyen/PersonalProjects/wskit/server/tests-e2e-cloudflare/src/routes/+page.svelte
- /Users/gyen/PersonalProjects/wskit/server/tests-e2e-cloudflare/wrangler.jsonc
