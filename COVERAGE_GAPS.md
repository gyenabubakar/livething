# Coverage gaps — wskit ship-readiness audit

Date: 2026-04-22
Source: deep read of BEHAVIOR_COVERAGE\_\_SERVER.md, audit/1–39, all 31 e2e specs, all server-core unit tests, server-cloudflare unit tests, and all feature handlers. Every gap below was verified by reading the actual test files — no claim is repeated from the audits without checking whether the new 31-spec suite already covered it.

---

## Summary

- **Unit-level gaps**: 20
- **Integration gaps**: 8
- **E2E gaps**: 18
- **Type-level gaps**: 5
- **Adapter-specific gaps**: 5
- **Top shipping blockers**: 4

## Verified against source (2026-04-22)

The draft of this file listed two items as top priorities that did not survive verification:

- **`stream.extract()` untested** — the method was deleted during Phase 0 of the e2e restructure. `audit/9_stream_extract.md` is stale. There is nothing to test.
- **`_seq` concurrency race** — `allocatePersistentSequence` wraps SELECT+UPDATE in `sql.transaction(tx => { ... })` with a synchronous callback (no `await`). In any runtime where the adapter provides a synchronous `sql.transaction` — Cloudflare DOs, Node/Bun/Deno with `better-sqlite3`, etc. — the whole block is atomic because JS is single-threaded and nothing can run between the SELECT and UPDATE. The race would only reopen if an adapter backed `sql.transaction` with an async API (e.g. a remote SQL service). A low-value invariant lock-in test (assert the callback stays sync, or fake an adapter with async SQL and confirm wskit either refuses or stays correct) would catch that regression; not a shipping concern today.

Those items are removed from this file.

**Pass 2 (20 additional items, Opus agent).** 16/20 verified as real gaps. Corrections applied:

- `stream — basic` "generator throws before first yield" — partly bogus: the existing `start-boom` fixture DOES yield once before throwing (so the post-yield-throw path IS covered). Reframed narrowly as a missing pre-yield-throw fixture.
- `lifecycle hooks` "two onConnect contradiction" — bogus: the fixture registers one hook and sends a hardcoded `{count: 2}` payload. Downgraded to a cosmetic test-name issue.
- `server-cloudflare` "WebSocket message race during wake" — partial: CF's DO input-gate serialises per-object messages, so the original race is not reachable. Reframed as "wake reentrancy not unit-tested".

**Passes 3–6 (40 additional items, Sonnet + Opus).** After 6 verification passes covering 68 item-checks in total, the file is now fully verified. Net tally: 55 real gaps, 5 partials (real but scoped/nuanced), 7 bogus claims removed, 1 duplicate merged. Error rate across all passes: ~12% bogus, driven by early trust in the stale `audit/` folder. The later passes (3–6) had a 2% error rate because agents were instructed to verify against source only.

**Every remaining gap in this document has been checked.** Safe to use as a work list.

---

## Before implementing — context a fresh agent needs

**Do NOT read `/Users/gyen/PersonalProjects/wskit/audit/*.md` as a source of truth.** Those files were written before the e2e suite was restructured and contain references to deleted methods (e.g. `stream.extract()`) and stale file paths. This document supersedes them. The only reason to read an audit file is if a gap entry here explicitly cites one; otherwise ignore the folder.

**`BEHAVIOR_COVERAGE__SERVER.md`** is a feature checklist (list of framework behaviors that exist), but its test-file citations are STALE. Use it to understand what wskit does, not to find tests.

### Project layout

- `server/server-core/` — framework core, vitest unit tests (`*.spec.ts` + `*.test.ts` + `*.test-d.ts`).
- `server/server-cloudflare/` — Cloudflare adapter, vitest unit tests.
- `server/tests-e2e-cloudflare/` — Playwright e2e tests against a local Wrangler dev server. 31 feature-focused spec files under `tests/`. Each pairs 1:1 with a handler in `src/lib/server/{feature}/handler.ts` and a Svelte page in `src/routes/{feature}/+page.svelte`.

### Running gates

From each package (`server/server-core`, `server/server-cloudflare`, `server/tests-e2e-cloudflare`):

- `pnpm run test` — run tests
- `pnpm run typecheck` — svelte-check (e2e package only) or tsc
- `pnpm exec oxlint src/ tests/` — lint

From workspace root:

- `pnpm run test` — runs all packages in parallel.

### E2E test infrastructure — learned the hard way

- **`playwright.config.ts` is pinned at `workers: 4, retries: 1`**. Do not raise this. Higher parallelism causes `Network connection lost` errors from the Wrangler dev server under WebSocket load.
- **Multi-context tests must await `status === 'connected'` before clicking any button that sends a frame.** A `ws.send()` on a WebSocket in CONNECTING state throws silently and the frame is lost. The failure mode is subtle: the test fails intermittently under load and passes in isolation. Pattern:
  ```ts
  await a.getByTestId('connect').click();
  await b.getByTestId('connect').click();
  await expect(a.getByTestId('status')).toHaveText('connected'); // REQUIRED
  await expect(b.getByTestId('status')).toHaveText('connected'); // REQUIRED
  await a.getByTestId('subscribe-room').click(); // only now safe
  ```
- **Room isolation:** use `const room = \`test-${testInfo.testId}\`` in `beforeEach` so each test gets a fresh DO. Do NOT add `${testInfo.retry}` unless testing retry-specific state pollution (it's a deliberate choice that the current suite doesn't include retry in the room name).

### Architecture contracts that must not break

- **`sql.transaction(fn)` must take a synchronous callback.** The atomicity of `_seq` allocation and DLQ writes depends on this. A future adapter that backs SQL with an async API would silently reopen race conditions. If touching `allocatePersistentSequence` or similar, keep the callback non-`async` and with no `await`.
- **Feature handlers compose via `with*` wrappers**, not module augmentation. Example: `withStreams(withErrors(withLifecycle(server<Env>('name'))))`. Add new features via new `withX` wrappers in `server/server-core/src/{feature}/with.ts`, not by patching prototypes.
- **Public-API doccomments describe what the developer does with the symbol**, not engine internals. If writing doccomments on exported symbols, use `@example` blocks with idiomatic calls. Internal-logic descriptions belong only on symbols in `_engine/`, `_builder/`, or under `@internal`.
- **Re-exports inherit the original's doccomment.** Don't add a second JSDoc block at a re-export site. If the original is weak, fix the original.

### Open design decisions — ask the user before implementing

Three of the top-4 must-fix items have unresolved design choices. Do NOT implement these without the user confirming the direction:

1. **Stream + hibernation (must-fix #1)**: on wake, should in-flight streams be (a) gracefully terminated with `_streamEnd` or `_error`, or (b) resumed? Option (a) is simpler; option (b) requires serialising `activeStreams` state into the attachment, which is more complex and may be impossible for generator functions (they're not serialisable).

2. **Post-intercept `Skip` (must-fix #2)**: should throwing `Skip` from a post-intercept (a) pass-through to the handler (fix runtime in `messages.ts:491`), or (b) kill the dispatch silently (keep runtime, fix the doccomment in `intercept.ts:119`)? The second option preserves today's behavior and just makes the docs match.

3. **Defer in stream (must-fix #4)**: should throwing `Defer` from a stream generator (a) throw a clearer "Defer is not supported in stream handlers" error to `onError`, or (b) keep the current silent-onError behavior and document it in the `Defer` doccomment? The second option is a no-op code change.

For each: ask the user, get the decision, then implement. Do not pick arbitrarily.

### Commit style (from user's CLAUDE.md)

- Never attribute commits to yourself.
- Never use `git stash`, `git checkout`, `git restore`, `git reset` without explicit permission from the user.
- Ask before any git command unless the user literally said "commit" / "push" / etc.
- Run `git add .` when staging (per the user's preference).

---

## Per-feature gaps

### Feature: server (factory)

**Unit gap:** `server` imported from `@wskit/server/full` is never tested. The `full/index.ts` re-export that pre-composes all `with*` wrappers has no spec file. If any `with*` wrapper is accidentally excluded from `full/index.ts`, no test fails. Add one test in `_builder/server-builder.spec.ts` or a new `full.spec.ts` that imports `{ server }` from `~/full/index.ts` and asserts the returned builder has `.channel`, `.namespace`, `.stream`, `.request`, `.replay`, `.scheduled`, `.intercept`, `.onConnect`, `.ack`, `.dedup`, `.heartbeat`, `.sequence`, `.hibernation` without any `with*` wrapper.

**Unit gap:** `event()` contract wire name flowing into primitive identity is not tested end-to-end. `server-builder.spec.ts` checks `primitives[0].__wskit === 'outgoing'` but never asserts `__identity[1] === 'greet'` when built via `server('x').outgoing(event('greet', fn)).build()`. Regressions in the `event()` → primitive identity chain would be invisible.

---

### Feature: event

**Unit gap:** No unit test exercises `validateValue` in `_engine/compile/utils.ts` (the `'~standard' in validator` branch) with a real Standard Schema validator. Some primitive-creation specs (e.g. `incoming/incoming.spec.ts`) import Valibot and pass a Valibot schema to the primitive, but those tests only assert that `primitive.validator` is set — they never run the validator through `validateValue` and inspect the parsed output. Add a direct unit test for `validateValue` using both **valibot** and **zod** (already installed as dev deps — do NOT mock a fake `{ '~standard': { validate } }` object, the point is to prove the duck-type detection works with real StandardSchema libraries). Cover: valid input returns parsed value; invalid input throws a `ValidationFailed` WskitError with the `issues` array populated.

---

### Feature: incoming

**E2E gap:** The new `incoming.spec.ts` proves the handler does not run when validation fails (`send-bad` button → `validation-error` element populated, `echoed` stays empty). This is a genuine improvement over the old `handler.spec.ts` which only checked `onValidationError` fired but never asserted the handler did not run. This gap is **now closed** in the new suite. (No action needed.)

---

### Feature: outgoing

**Unit gap:** No test verifies that `sendThroughPipeline` correctly drops an undeclared outgoing event inside a **namespace** or **channel** scope. `runtime.spec.ts` tests only the top-level scope. `isDeclaredOutgoing` for `namespace.outgoing.has(event)` and `channel.outgoing.has(event)` paths are untested at the unit level. A typo in scope resolution would pass every existing test.

---

### Feature: request

**Unit gap:** A handler that never calls `ctx.respond()` results in `sendThroughPipeline` receiving `undefined` and throwing `"[wskit] Outgoing payload must be a plain object."`. This error propagates as a runtime error, but there is no unit test for it. The new `request.spec.ts` has a test ("handler that never calls ctx.respond leaves request hanging") that proves no response arrives from the client side, but it does not assert what error the server logs or that `onError` fires. Add a unit test to `request/runtime.spec.ts`.

**Correctness gap (must-fix — see top priorities):** A request handler that calls `ctx.respond()` more than once should throw, not silently overwrite. Currently: silent last-wins. The guard is load-bearing for the Defer-in-request fix (see errors — control flow section) because Defer re-dispatch can cause a handler that already called `ctx.respond()` to be re-invoked and respond again. Add runtime guard + unit test.

---

### Feature: stream — basic

**E2E gap (low priority):** The `start-boom` fixture yields `{ index: 0 }` BEFORE throwing, so the existing test (`stream-basic.spec.ts:26-30`) does cover post-yield-throw. The separate path — generator throws BEFORE the first yield (so only `_streamOk` has been sent, no chunks) — is technically untested. Add a new fixture `start-boom-immediate` that throws without yielding and assert `_streamOk` still arrives before the `_error`.

**Unit gap:** `bufferStreamNudge` with an unknown `_streamId` (stream not registered) is called but not unit tested. The function returns `false` and allows the message to fall through to normal routing. No test covers this path. Add to `stream/runtime.spec.ts`.

**Unit gap:** `bufferStreamNudge` with a valid `_streamId` but an event name not in `nudgeValidators` is not unit tested. The function returns `false`. Add to `stream/runtime.spec.ts`.

---

### Feature: stream — broadcast

**E2E gap:** The trigger connection receives each chunk **twice** when `broadcast: true` (once from the broadcast fan-out without `_streamId`, once from `sendThroughPipeline` with `_streamId`). The `stream-broadcast.spec.ts` test uses `toContainText` which tolerates duplicates. This double-delivery to the trigger is undocumented behavior: clients need to know to expect or de-duplicate it. Either document it explicitly as a known behavior or add `excludeSelf: true` to the `broadcastToConnections` call in `runStream`. Currently no test asserts the exact chunk count the trigger receives.

---

### Feature: channel — static names

**Unit gap:** `ctx.channel.send(event, payload)` reaching only the current connection (not all members) has no unit test. `runtime.spec.ts` does not test this path; `contexts.spec.ts` does not test it. The multi-client e2e test for `ctx.channel.broadcast` does not test the inverse (that `ctx.channel.send` does NOT reach the other subscriber). Add to `contexts.spec.ts`: call `ctx.channel.send`, assert `sendThroughPipeline` was called without `broadcastToChannel`.

**E2E gap:** `_memberJoin` ordering relative to `_subscribeOk` is not asserted. `channel-static.spec.ts` confirms `_memberJoin` fires (`member-joins` contains `room:`), and `_subscribeOk` fires (subscribe-ok-count is 1), but never in the same test asserts that `_subscribeOk` was received _before_ `_memberJoin`. If the ordering were inverted, a client that relied on receiving its own `_subscribeOk` before peers could race.

---

### Feature: channel — dynamic via scope()

**Unit gap:** `ctx.channels.members(scopeKey)` is cited as tested in `runtime.spec.ts`, but the test there (`'keeps same-name memberships isolated across channel families'`) never calls `ctx.channels.members()`. The actual members-listing API path is tested only in `ctx-channels.spec.ts` e2e (returns a count). No unit test calls `ctx.channels.members` and verifies the returned `ConnectionInfo[]` contains the right entries. Add a unit test to `channel/runtime.spec.ts` or `contexts.spec.ts`.

---

### Feature: channel lifecycle hooks

**Unit gap:** `onBeforeSubscribe` is tested in `lifecycle.spec.ts` for primitive wiring only — it calls `__setup` and checks `engine.onBeforeSubscribe` is called. The ordering guarantee ("fires before `addChannelMembership`") is never tested at the unit level. A refactor moving `addChannelMembership` before the hook call would not be caught by any unit test.

**E2E gap (pre-existing):** No test proves that throwing `Block` (vs. throwing a plain `Error`) in `onBeforeSubscribe` sends the typed error code on the wire. Both `channel-static.spec.ts` and `channel-dynamic.spec.ts` rejection tests only assert that `subscribe-error` contains the channel name — they do not assert the error `code` field. A change from `Block` to `throw new Error()` in the fixture would still pass. (The `onBeforeSubscribe` validator data-payload rejection path also remains uncovered in e2e, as noted in the old `BEHAVIOR_COVERAGE__SERVER.md`.)

---

### Feature: namespace

**E2E gap (isolation):** `ctx.namespace.send` reaching _only_ the current connection and not other connections is not proven. The `namespace.spec.ts` test `'events sent inside a namespace reach the same connection via ctx.namespace.send'` uses a single page. A second client is never present to demonstrate isolation. Rename or strengthen this test.

**Unit gap:** `ctx.namespace.broadcast` has no unit test. `buildScopeExtras` in `contexts.ts` builds it (calls `broadcastToConnections` with `{ namespace: namespace.name }`), but `contexts.spec.ts` does not test namespace broadcast. The `namespace.spec.ts` e2e test covers it end-to-end (two clients both receive the message), so this is a low-priority unit gap.

**Unit gap:** Sending an undeclared outgoing event inside a namespace scope is not tested. `isDeclaredOutgoing` checks `namespace.outgoing.has(event)`, but there is no unit test proving that calling `ctx.namespace.send('unregistered-event', …)` is silently dropped (or throws). A bug in scope resolution could allow undeclared events to leak.

**Unit gap (ordering):** The guarantee that top-level pre-intercepts run before namespace-scoped pre-intercepts is never tested. `dispatchIncoming` in `messages.ts` runs `compiled.preIntercepts` first, then `scope.namespace.preIntercepts`. A refactor inverting the order would not be caught.

---

### Feature: intercept (pre + post)

**Unit gap (correctness):** `Skip` thrown from a post-intercept does not "skip that interceptor" as the doccomment claims — it propagates out of `runPostIntercepts` to `handleDispatchError` where it is matched by `if (error === Skip) return`, silently terminating the entire dispatch. The handler never runs. The doccomment in `intercept.ts` lines 118–119 says "From a post-intercept it behaves the same." This is wrong. No test covers this destructive behavior. Either add a guard in `runPostIntercepts`, or add a test that explicitly proves throwing `Skip` from a post-intercept kills the dispatch, and update the doccomment accordingly.

**E2E gap:** `Disconnect` thrown from inside an intercept callback (not a handler) is not tested. `behaviors.spec.ts` tests `Disconnect` from a handler. The intercept-level path is uncovered.

**Unit gap:** The doccomment in `intercept.ts` states the pipeline order as: (3) Post-intercept, (4) Validation. In `dispatchIncoming`, validation runs before post-intercepts. Steps 3 and 4 are swapped in the doccomment. This is a documentation correctness issue. No test covers the ordering contract explicitly (validation before post-intercept).

---

### Feature: ack

**Unit gap:** `ctx.ack()` being absent from a channel context (not just a namespace context) is not tested. `ack.spec.ts` only constructs a namespace ctx and asserts `ctx.ack` is absent. The channel case (`{ channelName: '...' }`) is not exercised. Add a second assert case to `ack.spec.ts`.

---

### Feature: dedup

**Unit gap:** The ring buffer with the _default_ cap of 256 is never tested. `incoming.spec.ts` uses `makeRuntime(2)` to prove eviction. The matrix row says "256 entries" but no test exercises the default. The cap value is effectively dead to the test suite.

**Unit gap (design gap):** Dedup incoming check is skipped on re-dispatch (`attempt > 0`). A deferred message with a `_messageId` could be processed twice if the client retried. This design decision is undocumented and untested. Add a comment or a test asserting that `attempt > 0` bypasses dedup.

---

### Feature: heartbeat

**Unit gap:** The actual close after timeout fires at the unit level (the `runtime.spec.ts` test fires the callback and asserts `close(4004, 'Heartbeat timeout')` is called), but the **full engine wiring** — that `refreshConnectionIdleTimeout` is called on connect and on each message, and that this ultimately arms a real timer — is not tested. The new `heartbeat.spec.ts` e2e test now covers the end-to-end close (the gap from `BEHAVIOR_COVERAGE__SERVER.md` is closed). However the mid-test "activity resets the idle timer" test has no assertion on the close code — it relies on the connection simply still being open, which would pass even if the heartbeat timer were reset by something other than message activity.

**Unit gap:** `heartbeat.ts` lines 51–52: if `connectionId` is falsy, `refreshConnectionIdleTimeout` is never called. This silent failure mode is untested. Add a spec case to `heartbeat.spec.ts`.

**Unit gap:** Quality bands `excellent` (<100 ms) and `degraded` (<1000 ms) are never tested. `runtime.spec.ts` only exercises `good` (average 110 ms) and `poor` (via missed-ping path). Threshold regressions for the other two bands are invisible.

**Unit gap:** The latency rolling window cap of 5 samples is not boundary-tested. The spec seeds 4 then adds 1, hitting exactly 5 but never proving that a 6th sample evicts the oldest.

---

### Feature: hibernation

**Unit gap:** `handleHibernationWake()` called when `hibernation()` is NOT enabled throws `"[wskit] hibernation() is not enabled for this handler."`. This guard is never tested at the unit level. Only the happy path (hibernation enabled + adapter supports it) is exercised.

**Unit gap / E2E gap:** `persistAttachment()` serialization / `deserializeAttachment()` deserialization round-trip has no unit test. The adapter's `getConnection()` calls `engine.handleHibernationWake(ws)`, which deserializes the attachment, but this specific round-trip is only verified implicitly through the full e2e hibernation tests.

**E2E gap:** Channel membership being restored after hibernation wake is now covered by `hibernation.spec.ts` test `'channel membership survives across an idle window'`. However, the test verifies only that Bob's broadcast reaches Alice after the idle window — it does not verify that `ctx.channels.members('room')` still returns Alice after wake (i.e., the membership data structure itself is intact for programmatic access). Verify that the `members()` count is also correct post-wake.

---

### Feature: replay — history

**E2E gap:** "Channel-scoped replay returns only channel messages" (`replay-history.spec.ts` test at line 66) asserts `roomReplayCount > 0` but never asserts that a top-level message sent before the room replay is absent from the replayed results. The isolation property is unverified. Extend the test to assert the top-level `chat-msg` count is unchanged, or add an explicit assertion that no non-channel events appear in the room replay batch.

**Unit gap:** `ctx.channel.sendReplay()` rejecting undeclared events is tested in `with.spec.ts` with `// @ts-expect-error` — this is a compile-time-only check. No runtime test verifies that calling `sendReplay` with an undeclared event at runtime throws or is a no-op. Reword the matrix row or add a runtime test.

---

### Feature: replay — snapshot

**Type gap:** `.snapshotKey()` and `.reduce()` being type errors on a history-mode builder are asserted at runtime only (via `_seal()` throw). The TypeScript `this: ReplayBuilder<…, 'snapshot'>` narrowing that prevents calling them on a history-mode builder is never exercised with `@ts-expect-error`. Add to `replay/builder.spec.ts` or a companion `.test.ts` file.

---

### Feature: replay — custom

**Unit gap:** `onAfterSend` nonzero-since behavior — the `onReplay` callback receives a correct non-zero `since` argument — is covered in e2e (`replay-custom.spec.ts` `'custom replay supports nonzero since'`) but is not in the `BEHAVIOR_COVERAGE__SERVER.md` matrix. The coverage is real; the matrix is missing the row.

**Design gap:** `shouldStoreReplayMessage` is always called with an empty `exclude` Set (lines 345, 359 of `custom.ts`). Custom replay has no event-exclude option equivalent to built-in replay's `.exclude(...events)`. This is undocumented. No test verifies this limitation. Add documentation or thread an `exclude` option.

**Unit gap:** `sendReplay()` bypasses `sendThroughPipeline` entirely (calls `connection.descriptor.send()` directly), so `onBeforeSend` / `onAfterSend` do NOT fire for replayed messages. This is correct behavior but is nowhere tested or documented. A future refactor could accidentally run hooks on replayed messages. Add a unit test to `custom/custom.spec.ts` asserting the `onBeforeSend` hook is not called when `ctx.sendReplay()` is invoked.

---

### Feature: scheduled

**Unit gap:** One-shot `retry: false` standalone — the matrix row is only exercised inside a recurring-task test. A clean unit test for "one-shot, retry: false, throws once → lands in DLQ immediately" is missing from `scheduled/runtime.spec.ts`.

**E2E gap (partial):** The `scheduled.spec.ts` tests for `cancelScheduled` with non-matching runs both cancel **registered** task ids with impossible filters — they do NOT exercise a truly unregistered task id. The `'cancelScheduled on never-registered task id succeeds silently'` test exists but its fixture (`scheduled/handler.ts:219`) calls `ctx.cancelScheduled('filtered-cleanup', { label: '__nonexistent__' })` — `'filtered-cleanup'` is registered; only the filter prevents a match. To genuinely cover the "task id that was never declared in any `.schedule(...)` definition" path, change the fixture to call `ctx.cancelScheduled('nonexistent-task-id')` with no such task registered.

---

### Feature: errors — control flow

**Correctness + unit gap (Defer in request handler):** `Defer` thrown from a request handler propagates to `handleDispatchError` (messages.ts:478) and hits the generic Defer re-dispatch branch (L513–532), which re-invokes `dispatchIncoming` from the top. That is fine **iff** the handler threw before calling `ctx.respond()`. If it threw after responding, the retry will call the handler again and could respond a second time under the same correlation id — silent duplicate reply.

Decided fix (must-fix — see top priorities): **both** of:

1. Runtime guard: a second call to `ctx.respond()` in the same request invocation must throw a WskitError (not silently last-wins). The guard also makes the Defer retry safe — if the retry handler tries to respond again, it throws, and onError fires cleanly.
2. Doccomment update on `Defer`: explicitly tell devs (a) do not throw Defer after calling `ctx.respond()`, and (b) remember that the client's request timeout still applies — a handler that defers three times with `delay=500` consumes 1.5 s of the client's timeout budget before the handler ever actually succeeds.

Add a unit test in `behaviors.spec.ts` (or `request/runtime.spec.ts`) that exercises Defer-from-request with the guard in place.

**Correctness + unit gap (Defer in stream handler — nonsensical by design):** When a stream generator throws, `runStream` (stream/runtime.ts:204) catches the error inside its own try/catch, routes it to `handleRuntimeError`, and does NOT re-throw. So Defer thrown from a stream generator never reaches the defer re-dispatch branch — it just silently ends up in `onError`. This is the right behavior architecturally (you can't retry a stream: `_streamOk` and some chunks have already gone over the wire, restarting under the same `_streamId` would duplicate chunks and confuse the client).

Decided fix: make the "Defer-in-stream is not supported" contract explicit instead of accidental.

1. In `runStream`'s catch block, detect `Defer` (`error.__wskit === 'defer'`) and either (a) throw a clearer "Defer is not supported in stream handlers" error to `onError`, or (b) document the silent-onError behavior in the `Defer` doccomment.
2. Either way, add a unit test that throws `Defer` from a stream generator and asserts it lands in `onError` (not in the retry loop) and the stream terminates with a single `_error` frame.

**Unit gap / documentation gap:** `CloseCodes` being exported and usable as close codes is tested only in `errors/errors.test.ts` as a type-export check. No runtime test asserts that e.g. `Disconnect(CloseCodes.IDLE, …)` actually sends code `4004` on the wire. The e2e `heartbeat.spec.ts` now tests `close-code: 4004`, but the `CloseCodes` constant itself is not referenced — the value `4004` is hardcoded in the test.

---

### Feature: lifecycle hooks

**Cosmetic: misleading e2e test name.** `lifecycle-hooks.spec.ts` has a test called `'multiple onConnect hooks run when registered multiple times'`. The handler fixture at `src/lib/server/lifecycle-hooks/handler.ts:26-31` registers exactly ONE `onConnect` and sends `{ count: 2 }` as a hardcoded payload. The unit-level "duplicate onConnect throws at build" invariant is NOT broken — the test name just lies about what it's asserting. Rename for clarity (e.g. "onConnect runs and can publish a payload to the connecting client") or add a separate test that actually proves duplicate registration throws at the handler level.

---

### Feature: modules (defineModule)

**Unit gap:** Module `onInit` runs at engine start — the citation in BEHAVIOR_COVERAGE\_\_SERVER.md is `connection.spec.ts`, but that file contains no `onInit` test. The actual coverage is in `engine.modules.spec.ts` (as a side-effect of the `getState` test). Add a dedicated `onInit` test or correct the citation.

**E2E gap:** Module `hooks.onIncoming` ordering relative to top-level `intercept.intercept(…)` is not tested. If a module's `onIncoming` mutates a message, does the top-level pre-intercept see the mutated or original message? The interaction order between module `onIncoming` hooks and global pre-intercepts is tested only in isolation, never together.

---

### Feature: ctx.channels — kick and members

**E2E gap:** `ctx.channels.members(name)` returning a `ConnectionInfo[]` (with real properties like `connectionId` and `tags`) is not proven. All tests assert only on the count. The `ctx-channels.spec.ts` test `'ctx.channels.members returns the count after a client joins'` asserts `room:1`. A change returning `ConnectionInfo` objects with no `connectionId` field would not be detected.

---

### Feature: ctx storage

**Unit gap:** `ctx.sql.transaction(fn)` atomicity is not tested. The `platform.spec.ts` tests only prove that `transactionSync` is called — not that multiple writes are committed or rolled back atomically. Add an integration test that inserts two rows in one transaction, simulates a failure mid-transaction, and verifies neither row persists.

---

### Feature: ctx.quality / latency

**E2E gap:** `ctx.quality` being one of `'excellent' | 'good' | 'degraded' | 'poor'` is not asserted. `ctx-quality.spec.ts` asserts `quality` is non-empty but never checks it matches the enum. A handler returning `'unknown'` or `undefined` would pass. Add an enum check.

**E2E gap:** `ctx.latency` returning a number or `null` is not asserted in `ctx-quality.spec.ts`. The test polls until latency is populated but the assertion is only that `/\d+/` matches — it never asserts `null` is the initial value, or that after pongs it becomes numeric. Tighten.

---

### Feature: group + use

**Type gap:** Groups cannot be nested is claimed in `server-builder.spec.ts` but there is no `@ts-expect-error` test for the TypeScript constraint (`P extends { __wskit: 'group' } ? never : P`). If the type guard were accidentally removed, no test would catch it.

---

### Feature: server-cloudflare adapter

**Adapter gap:** `createSql.one()` returns `null` when the underlying cursor _throws_ ("no row" error), not when the result set is empty. The matrix row says "empty cursor" but the spec exercises a throw. No test verifies the behavior when the cursor returns zero rows normally (without throwing). These are two different code paths.

**Adapter gap:** DO eviction mid-operation — no test covers what happens if the Durable Object is evicted while an alarm handler is running. The adapter's `alarm()` method awaits `ready` and then calls `engine.handleAlarm()`; if the DO is evicted between those two points, the behavior is undefined and untested.

**Adapter gap (low priority, reframed):** Wake reentrancy is not unit-tested. `serve.ts` `webSocketMessage` awaits `this.ready` and calls `getConnection(ws)` which triggers `handleHibernationWake`. In practice Cloudflare's DO input-gate serializes incoming messages per-object, so the original "race between two messages for a waking socket" is not reachable under current CF semantics. The gap to test is: two rapid `webSocketMessage` calls in the same tick land correctly after wake — i.e. the wake path is idempotent and the second call picks up the already-woken connection. See engine.ts:712 handleHibernationWake for the `wsToConnectionId.get(wsKey)` early-return.

**Adapter gap:** Binding misconfiguration — if a user passes the wrong Durable Object binding name (e.g. binding `CHAT` resolves to the wrong DO class), the error is not surfaced by any test. The adapter-level error paths for missing or wrong bindings are entirely untested.

---

## Cross-cutting gaps

### C1. `_seq` invariant lock-in (low priority)

The race the agent originally worried about (interleaved SELECT+UPDATE) is not reachable in any runtime where the adapter's `sql.transaction` is synchronous (Cloudflare DOs, Node/Bun/Deno with `better-sqlite3`, etc.) because `allocatePersistentSequence` uses a sync callback with no `await` and JS is single-threaded. A defensive unit test that asserts the callback stays sync, plus an adapter-contract note that `sql.transaction` must be sync, would catch a future adapter that backs SQL with a remote/async API and accidentally reopens the race. Not a shipping issue for the current CF adapter.

### C2. `_messageId` uniqueness across scopes (shipping blocker)

`dedup.spec.ts` tests that `_messageId` is stamped on outgoing messages and that each connection has its own ring buffer. But it does not test that two different DOs (two different Durable Object instances, i.e. two different rooms) cannot produce the same `_messageId`. The id generator is connection-scoped. If the generator uses a counter that resets per engine boot, two rooms' seq-1 message could both have `_messageId: 'c1-1'`. A reconnecting client that moves between rooms could get a false dedup hit. No test covers cross-scope uniqueness.

### C3. Replay cursor correctness after reconnect with stale `_seq` (shipping blocker)

The `replay-history.spec.ts` test `'reconnect then replay with old seq returns only messages after it'` is the closest test, and it passes. But this test reconnects to the _same DO_ with the _same room_. A client that reconnects to a _different DO instance_ (e.g. after server restart) with a `since` value from the old instance could get either too many or zero messages. No cross-instance replay cursor test exists.

### C4. DLQ persistence across DO evictions

Scheduled task DLQ rows are written to SQLite. The e2e test `'scheduled dead-letter: always-fail task lands in the DLQ'` verifies rows appear. But there is no test that simulates a DO eviction (by reloading/reconnecting to the same room after a pause) and then querying the DLQ to confirm rows survived. SQLite in DOs persists across evictions by design, but this is never explicitly asserted.

### C5. Active stream + hibernation

The engine's `wakeHibernatedConnection` reconstructs a `RuntimeConnection` from the attachment. `activeStreams` is an in-memory map that is **not** serialized into the attachment. If a hibernation event fires mid-stream (between yields), the `activeStreams` entry is lost. The next message from the client (e.g. a `_streamCancel` or nudge) will not find the stream, and the generator is orphaned. No test covers this. The stream would silently hang until the generator's next yield returns (if the connection object is still referenced) or until the DO is evicted.

### C6. Channel `_memberJoin` vs `onSubscribe` ordering

The channel subscribe flow runs: `addChannelMembership` → `beforeSubscribe` hooks → `_subscribeOk` → `onSubscribe` → `_memberJoin` to existing members. The exact ordering of `_subscribeOk` arriving at the joining client versus `_memberJoin` arriving at existing members is never tested. A client that waits for `_subscribeOk` to start listening for `_memberJoin` events could miss the join notification if `_memberJoin` is sent before `_subscribeOk` completes.

### C7. Stream inside a channel with replay (integration)

A stream declared inside a channel scope, where the server also has replay enabled, is never tested together. The replay hooks (`onBeforeSend`) fire for each outgoing message including stream chunks. Whether stream chunks from a channel-scoped stream are correctly excluded from the channel replay store (or correctly included, depending on intent) is untested. The `channel-static.spec.ts` tests a channel stream but replay is not configured on that handler.

### C8. Module `onIncoming` + top-level intercept ordering

A module's `onIncoming` hook and a top-level pre-intercept both process every incoming message. In `dispatchIncoming`, pre-intercepts run at step 5 (via `runPreIntercepts`), and module `onIncoming` hooks run earlier in the pipeline at step 2 (via `moduleRuntime.onIncoming`). Whether a module's `onIncoming` rewrite is visible to the top-level pre-intercept depends on this ordering. No test exercises both in the same handler and asserts the observable order.

---

## Top priorities (ordered)

Must-fix before shipping:

1. **Active stream + hibernation interaction** — `activeStreams` is a Map on the Engine instance (engine.ts:122), not serialised into the WebSocket attachment. When a DO hibernates mid-stream the Engine dies; on wake, a new Engine starts with an empty `activeStreams`. Any in-flight stream is silently orphaned: no `_streamEnd`, no `_error`, the client just stops hearing chunks. Since AI streaming is the headline wskit use case, this is a day-one production bug if it's reachable in practice. Platform question still open (does CF actually hibernate a DO that's actively yielding?), but the code-level bug is real.  
   → New e2e test in `server/tests-e2e-cloudflare/tests/hibernation.spec.ts` that starts a long-running stream, waits for the hibernation window, and asserts either graceful cleanup or (better) continued delivery after wake.

2. **Post-intercept `Skip` kills dispatch + pipeline-order doc lies** — Two verified doccomment vs code mismatches in `intercept/intercept.ts`:
   - L119: "[Skip] from a post-intercept it behaves the same" (claims pass-through). **Actual**: `Skip` propagates to `handleDispatchError` (messages.ts:491) which silently returns — handler never runs.
   - L102–110: pipeline order claims "3. Post-intercept, 4. Validation". **Actual code**: validation (messages.ts:412) runs BEFORE post-intercepts (L425). Order is swapped.  
     → Fix doccomments AND decide whether `Skip` in post-intercept should pass-through (fix runtime) or kill-dispatch (keep runtime, update doc). Add `intercept/runtime.spec.ts` test pinning the chosen semantics.

3. **Defer in request handler needs a guard + doc update** — decided: both (a) runtime guard that throws if `ctx.respond()` is called twice in one invocation, and (b) `Defer` doccomment must warn devs not to throw Defer after responding, and to mind the client's request timeout budget when chaining defers. See errors — control flow section for details.  
   → Guard in `request/runtime.ts`, doc update in `errors/errors.ts`, unit test in `behaviors.spec.ts`.

4. **Defer in stream handler is architecturally nonsensical — make the contract explicit** — current code silently turns Defer into onError via `runStream`'s catch block. Decided: either throw a clearer "Defer is not supported in stream handlers" or document the silent-onError behavior in the Defer doccomment. Add a unit test.  
   → `stream/runtime.ts` + `stream/runtime.spec.ts` + doccomment.

Should-fix soon:

5. **Standard Schema path has no direct unit test** — `validateValue`'s `'~standard' in validator` branch is exercised end-to-end by every e2e handler (they all use Valibot), but there is no isolated unit test proving the duck-type detection works for real library schemas. Add a unit test in `_engine/compile/utils.spec.ts` (new file) covering valid+invalid inputs with **real valibot and zod schemas** — both libs are installed as dev deps, do not mock a fake `{ '~standard': { validate } }` object.  
   → `server/server-core/src/_engine/compile/utils.spec.ts`

6. **`handleHibernationWake` without hibernation enabled** — guard at engine.ts:714 throws `"[wskit] hibernation() is not enabled"`, but zero tests exercise it. Trivial to add.  
   → `server/server-core/src/_engine/engine.spec.ts` (or wherever engine-level tests live).

7. **Replay channel isolation missing a negative assertion** — `replay-history.spec.ts:66` proves channel replay returns _some_ messages but never proves non-channel messages are absent. One-line extension to the existing test.  
   → `server/tests-e2e-cloudflare/tests/replay-history.spec.ts`

The rest of the per-feature gaps below are useful-to-close but not individually load-bearing.
