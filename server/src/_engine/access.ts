import type * as EngineCompileTypes from '~/_engine/compile/types.ts';
import type * as FeatureSlots from '~/_engine/runtime/feature-slots.ts';
import type * as Protocol from '~/_engine/runtime/protocol.ts';
import type * as EngineRuntimeTypes from '~/_engine/runtime/types.ts';
import type * as ContextApi from '~/context.ts';
import type * as ErrorsPrimitive from '~/errors/errors.ts';
import type * as InterceptPrimitive from '~/intercept/intercept.ts';
import type * as LifecycleTypes from '~/lifecycle/lifecycle.ts';
import type * as ScheduledPrimitive from '~/scheduled/types.ts';
import type { TagGroupRegistration } from '~/tags/tags.ts';
import type * as ValidationTypes from '~/types.ts';

type MessageParameter = { event: string; payload: unknown };
type FrameParameter = {
  event: string;
  payload: unknown;
  wskit: Protocol.WSKitProtocol | undefined;
};
type OptsParameter = {
  event: string;
  payload: unknown;
  correlationId: string;
  channel?: string;
  channelFamily?: string | null;
};
type OptionsParameter = {
  channelName: string | null;
  channelFamily: string | null;
  event: string;
  payload: unknown;
  wire: { seq: number; messageId: string; channel?: string };
};
type OptionsParameter2 = {
  channelName: string | null;
  channelFamily: string | null;
  missedThrough: number;
};
type OptionsParameter3 = { event: string; payload: unknown; wskit?: Record<string, unknown> };
type OptsParameter2 = {
  channelName: string;
  channelFamily: string | null;
  event: string;
  payload: Record<string, unknown>;
};

/**
 * The runtime registration surface built-in primitives receive during engine
 * initialization.
 *
 * Built-in primitives can use this to attach lifecycle hooks, message-pipeline
 * transforms, scoped channel hooks, and context extensions without getting the
 * full engine instance directly.
 *
 * This interface is consumed by two audiences: (1) platform adapter authors,
 * who use the lifecycle entry points, hook registration, and connection
 * helpers; (2) built-in primitives (`replay`, `sequence`, `dedup`, etc.),
 * which use the setup-time capability toggles. Adapter authors can ignore
 * the toggle methods — they are marked `@internal` and used only during
 * primitive __setup.
 */
export interface EngineAccess {
  /**
   * Install shared primitive runtime logic once.
   *
   * Use this when many instances of the same primitive may appear, but the
   * runtime behavior should only be wired into the engine a single time.
   *
   * @internal
   */
  installOnce(key: symbol, install: () => void): void;

  /**
   * Run internal startup logic before normal server init begins.
   *
   * This is for framework-owned boot work like restoring state from storage.
   * Product-level startup belongs in `onInit`, not here.
   */
  onBoot(handler: () => void | Promise<void>): void;

  /**
   * Like `onBoot`, but for `ensure*Schema` calls. The engine runs these on
   * every boot so a capability added after storage initialization still gets
   * its tables. Use this ONLY for idempotent `CREATE TABLE IF NOT EXISTS` work
   * — never for cleanup or state restoration, which must always run.
   */
  onBootSchema(handler: () => void | Promise<void>): void;

  /**
   * Register per-user durable cleanup, run by `admin().purgeUser()`. A
   * capability that owns per-user durable rows (channel membership,
   * persistent tags, ...) registers a handler here to drop its own rows.
   * Runs before the user's live sockets are closed. The `core` argument is
   * the live engine core, opaque here — a handler casts it internally to
   * reach the storage and services it needs.
   *
   * @internal
   */
  onPurgeUser(handler: (core: unknown, userId: string) => void | Promise<void>): void;

  /**
   * Observe or rewrite incoming wire messages before the engine routes them.
   *
   * Return a value to replace the payload, or return nothing to leave it
   * unchanged. The event name is locked at this point — routing is already
   * resolved — so the return value becomes the new payload only, even if
   * the returned object happens to have its own event field.
   */
  onIncoming(handler: (message: MessageParameter) => unknown | void): void;

  /**
   * Settle a server→client request answer before normal routing.
   *
   * Each incoming user-event frame carrying a `correlationId` is offered to the
   * registered hooks; a hook returns `true` when the id matches a pending
   * server-initiated request it owns, which stops routing. Used by the
   * `serverRequests()` capability so the engine never imports its pending map.
   *
   * @internal
   */
  onAnswerFrame(handler: (connectionId: string, frame: FrameParameter) => boolean): void;

  /**
   * Send a server→client request frame to one live connection.
   *
   * Routes through the normal outgoing pipeline with the given `correlationId`
   * (and optional channel family) so plugin stampers and `onBeforeSend`/
   * `onAfterSend` hooks still run. Returns `false` when the connection is no
   * longer live on this instance. Used by the `serverRequests()` capability for
   * `ctx.request(...)` and friends.
   *
   * @internal
   */
  sendServerRequest(connectionId: string, opts: OptsParameter): boolean;

  /**
   * Observe or rewrite outgoing wire messages before they are serialized.
   *
   * The handler gets the active connection's context (or `undefined` for a
   * fan-out broadcast) and the `OutgoingFrame` (`event`, `payload`, `owner`).
   * Return a value to replace the payload, or return nothing to keep the
   * original. Same locked-event semantics as `onIncoming`.
   */
  onOutgoing(
    handler: (ctx: unknown, frame: InterceptPrimitive.OutgoingFrame) => unknown | void,
    owner?: InterceptPrimitive.FrameOwner,
  ): void;

  /**
   * Contribute `__wskit` metadata to every outgoing user frame.
   *
   * The handler receives the event name and returns a partial `__wskit`
   * object merged into the frame — used by `sequence()` and `dedup()` to add
   * `seq` and `messageId`. Skipped for protocol frames. A value already set
   * from routing (e.g. a durable stream's own `seq`) is not overwritten.
   *
   * @internal
   */
  onWSKitStamp(handler: (event: string) => Record<string, unknown>): void;

  /**
   * Observe one fully prepared outgoing wire message before it is sent.
   *
   * The framework metadata — `seq`, `messageId`, scope routing markers — lives
   * on `message.wskit` by this point. This is an internal observer hook for
   * framework features such as replay storage; it is not a payload rewrite
   * hook. Throw to stop the send.
   *
   * @internal
   */
  onBeforeSend(handler: (message: EngineRuntimeTypes.WireOutgoingMessage) => void): void;

  /**
   * Observe one fully prepared outgoing wire message after it is sent.
   *
   * Use this for best-effort side effects that should not block delivery.
   */
  onAfterSend(
    handler: (message: EngineRuntimeTypes.WireOutgoingMessage) => void | Promise<void>,
  ): void;

  /**
   * Observe activity from one live connection before normal routing continues.
   *
   * This runs for each text websocket frame the server receives.
   */
  onConnectionActivity(handler: (connectionId: string) => void | Promise<void>): void;

  /**
   * Observe a real message from one live connection: every valid event frame —
   * protocol frames like `__subscribe__` / `__received__` and app events — but
   * not transport keepalive pings. Use this for "last did something" signals,
   * where an idle connection's keepalive should not count as activity.
   */
  onMessageActivity(handler: (connectionId: string) => void | Promise<void>): void;

  /**
   * Run logic when the server finishes booting.
   *
   * This receives the same init-style context that user-facing `onInit`
   * handlers see.
   */
  onInit(handler: (ctx: unknown) => void | Promise<void>): void;

  /**
   * Run logic after one connection has been accepted and its context exists.
   */
  onConnect(handler: (ctx: unknown) => void | Promise<void>): void;

  /**
   * Run logic after one connection has closed.
   */
  onDisconnect(handler: (ctx: unknown) => void | Promise<void>): void;

  /**
   * Run logic while the engine is shutting down.
   */
  onShutdown(handler: (ctx: unknown) => void | Promise<void>): void;

  /**
   * Observe runtime errors.
   */
  onError(handler: (ctx: unknown, error: unknown, event?: string) => void | Promise<void>): void;

  /**
   * Register an internal-primitive upgrade hook. Each primitive's
   * `__setup` may call this at most once — calling it twice from the
   * same `__setup` throws (programming error in the primitive).
   * Different primitives may each register their own hook; the engine
   * runs them all and merges the results.
   *
   * The user-facing builder hook registered via
   * `setBuilderUpgradeHook` always runs last and its meta keys
   * override any internal hook on conflict.
   */
  onUpgrade(
    handler: (
      request: Request,
      helpers: LifecycleTypes.UpgradeHelpers,
    ) =>
      | { meta?: Record<string, unknown>; tags?: readonly ContextApi.TagRef[] }
      | Promise<{
          meta?: Record<string, unknown>;
          tags?: readonly ContextApi.TagRef[];
        }>,
  ): void;

  /**
   * Register the user-facing builder upgrade hook. Throws if called more
   * than once. The lifecycle primitive routes `.onUpgrade(...)` through
   * this slot so the user's hook always wins on key conflict against
   * any internal-primitive hooks registered via `onUpgrade(...)`.
   */
  setBuilderUpgradeHook(
    handler: (
      request: Request,
      helpers: LifecycleTypes.UpgradeHelpers,
    ) =>
      | { userId?: string; meta?: Record<string, unknown>; tags?: readonly ContextApi.TagRef[] }
      | Promise<{
          userId?: string;
          meta?: Record<string, unknown>;
          tags?: readonly ContextApi.TagRef[];
        }>,
  ): void;

  /**
   * Observe validation failures for incoming payloads.
   */
  onValidationError(
    handler: (ctx: unknown, event: string, validationError: unknown) => void | Promise<void>,
  ): void;

  /**
   * Handle one reserved protocol message sent by the client.
   *
   * Return `true` when this handler consumed the protocol message so later
   * handlers stop running.
   */
  onProtocolMessage(
    event: Protocol.IncomingProtocolEvent,
    handler: (
      ctx: unknown,
      frame: Protocol.IncomingProtocolFrame,
    ) => boolean | void | Promise<boolean | void>,
  ): void;

  /**
   * Run logic when the adapter wakes the engine for an alarm.
   *
   * Scheduled tasks use this to process due work.
   */
  onAlarm(handler: () => void | Promise<void>): void;

  /**
   * Contribute one framework-owned deadline to the adapter's single durable
   * alarm. Sources are combined and the earliest deadline wins.
   *
   * @internal
   */
  registerAlarmSource(key: symbol, source: () => number | null): void;

  /**
   * Register the async check phase for a channel subscribe guard.
   *
   * The handler runs before membership is committed and may be async. The
   * optional validator validates the subscribe payload before the handler runs.
   * The return value is forwarded to the paired `onCommit` handler.
   */
  onCheck(
    handler: (ctx: unknown, data?: unknown) => unknown | Promise<unknown>,
    validator?: ValidationTypes.Validator<unknown>,
  ): void;

  /**
   * Register the re-authorization phase that runs on auto-rejoin only. The
   * handler runs when a reconnecting identity is restored to a persistent
   * channel; throwing revokes the membership. No subscribe payload is passed.
   */
  onRevalidate(handler: (ctx: unknown) => void | Promise<void>): void;

  /**
   * Register the sync commit phase for a channel subscribe guard.
   *
   * Receives the value returned by the paired `onCheck` handler. Must be
   * synchronous — returning a Promise throws at runtime.
   */
  onCommit(handler: (ctx: unknown, checkResult: unknown) => void): void;

  /**
   * Run logic after a channel subscription succeeds.
   */
  onSubscribe(handler: (ctx: unknown) => void | Promise<void>): void;

  /**
   * Run logic after a channel unsubscription finishes.
   */
  onUnsubscribe(handler: (ctx: unknown) => void | Promise<void>): void;

  /**
   * Register an `onSessionEnd` hook. Fires whenever this connection's view of
   * the channel ends — true leave OR plain disconnect.
   */
  onSessionEnd(handler: (ctx: unknown) => void | Promise<void>): void;

  /**
   * Read the scope information for the primitive currently being installed.
   *
   * Top-level primitives get an empty object. Channel-scoped primitives get
   * the channel key they belong to.
   */
  getScopeInfo(): { channelKey?: string };

  /**
   * Read the set of channel keys that have explicit replay registered.
   *
   * Server-level replay uses this to skip channels that registered their own
   * `.replay(...)` or `.replay(false)` — that scope is already claimed.
   */
  getReplayClaimedChannelKeys(): ReadonlySet<string>;

  /**
   * Add extra fields or methods to every live connection context.
   */
  extendContext(factory: (baseCtx: unknown) => Record<string, unknown>): void;

  /** The adapter's SQL and key-value storage. Every adapter provides this. */
  readonly storage: ContextApi.StorageProvider;

  /** The adapter's durable alarm implementation. Every adapter provides this. */
  readonly timers: ContextApi.TimerProvider;

  /**
   * Read the scope object the engine keeps open while it is running one
   * of its user-facing callbacks (an incoming WebSocket message, a close,
   * a WebSocket error, or a scheduled callback fire). Replay reads this so
   * it can hold snapshot-mode writes in memory and collapse many sends
   * that target the same key into one row write at the end of the
   * callback.
   *
   * Returns `null` when no such callback is running right now — in that
   * case the caller should write to SQL right away.
   *
   * @internal
   */
  getInvocationScope(): {
    pendingSnapshotFlushes: Map<
      string,
      { flush: (sql: Pick<ContextApi.SQLProvider, 'exec'>) => void }
    >;
  } | null;

  /**
   * Tell the engine whether this handler wants connection hibernation enabled.
   *
   * Adapters can then ask the engine for that decision instead of inspecting
   * primitive instances directly.
   *
   * @internal
   */
  setHibernationEnabled(enabled: boolean): void;

  /**
   * Read whether connection hibernation is enabled. `keepalive()` reads this in
   * its `ctx.quality` getter, which returns `null` while hibernating (no pings).
   *
   * @internal
   */
  getHibernationEnabled(): boolean;

  /**
   * Tell the engine that automatic replay is enabled for this handler.
   *
   * The engine uses this only for internal startup validation.
   *
   * @internal
   */
  setReplayEnabled(enabled: boolean): void;

  /**
   * Tell the engine whether `sequence()` is using durable SQLite-backed state.
   *
   * This lets startup validation ensure replay is paired with durable
   * sequence tracking.
   *
   * @internal
   */
  setSequencePersistent(enabled: boolean): void;

  /**
   * Register a set of declared tag groups of one kind. Used by the contract's
   * `tagGroups` config. Throws if a `(kind, name)` is declared twice in the
   * same contract.
   *
   * @internal
   */
  registerTagGroups(
    kind: 'ephemeral' | 'persistent',
    groups: readonly TagGroupRegistration[],
  ): void;

  /**
   * Record a per-channel `membership` override. The engine reads
   * this back at runtime via `isChannelDurable(channelKey)` to decide
   * whether to write a durable membership row on subscribe.
   *
   * @internal
   */
  setChannelDurable(channelKey: string, durable: boolean): void;

  /**
   * Record a channel's resolved inbox settings. The inbox fan-out, ack, and
   * clear paths read these back by channel key at runtime. Set by `inbox()`.
   *
   * @internal
   */
  registerInboxChannel(channelKey: string, options: FeatureSlots.ResolvedInboxOptions): void;

  /**
   * Record that a channel opted into read receipts, so `__subscribeOk__` can
   * carry the flag. Set by `readReceipts()`. @internal
   */
  registerReadReceiptsChannel(channelKey: string): void;

  /**
   * Check whether a durable-row `(channel_name, channel_family)` pair still
   * maps to a registered durable channel. Used by boot-time reconcile.
   * @internal
   */
  isDurableMembershipPairDurable(channelName: string, channelFamily: string | null): boolean;

  /**
   * Read the engine's logger. Used by primitives that emit boot-time or
   * one-off status messages (e.g. persistence cleanup row counts).
   * @internal
   */
  getLogger?(): ContextApi.Logger | undefined;

  /**
   * Turn on server-side deduplication of incoming messages.
   *
   * When enabled, the engine remembers the most recent `cap` `messageId`
   * values per connection and silently drops any incoming frame whose
   * `__wskit.messageId` is already in the window. Used by `dedup()` to protect
   * handlers from duplicate client sends (retries, flaky networks).
   *
   * @internal
   */
  enableIncomingDedup(cap: number): void;

  /**
   * Register the application's declared error definitions.
   *
   * The engine uses this registry only for runtime checks such as warning when
   * a thrown `WSKitError` was never declared in the contract's `errors: [...]`.
   */
  registerErrorDefinitions(defs: readonly ErrorsPrimitive.ErrorDef<string, unknown>[]): void;

  /**
   * Register a plugin's per-connection API factory under its id. `ctx.plugin(id)`
   * runs the factory against a plugin-scoped context. Two plugins sharing an id
   * is a build error.
   */
  registerPluginApi(id: string, factory: (ctx: unknown) => unknown): void;

  /**
   * Look up a registered plugin API factory by id, or `undefined` when no plugin
   * with that id is listed. Backs the `ctx.plugin(id)` accessor, which the plugin
   * system installs only when at least one plugin is listed.
   *
   * @internal
   */
  getPluginApiFactory(id: string): ((ctx: unknown) => unknown) | undefined;

  /**
   * Register one new-model plugin lifecycle hook. Kept apart from the app's so
   * the engine can run them in onion order. Hooks land in install order,
   * which equals host capability (registration) order, so inbound kinds run the
   * list head-first and outbound kinds run it in reverse (LIFO). The handler is
   * already wrapped in a plugin-scoped context.
   *
   * @internal
   */
  registerPluginLifecycle(
    kind:
      | 'init'
      | 'connect'
      | 'disconnect'
      | 'shutdown'
      | 'error'
      | 'validationError'
      | 'ping'
      | 'pong',
    pluginId: string,
    handler: (ctx: unknown, ...rest: unknown[]) => void | Promise<void>,
  ): void;

  /**
   * Register one new-model plugin `upgrade` hook. Runs before the app's upgrade
   * (inbound onion); it may own `userId`, but the single-owner rule is
   * enforced at runtime.
   *
   * @internal
   */
  registerPluginUpgrade(
    pluginId: string,
    handler: (
      request: Request,
      helpers: LifecycleTypes.UpgradeHelpers,
    ) =>
      | { userId?: string; meta?: Record<string, unknown>; tags?: readonly ContextApi.TagRef[] }
      | Promise<{
          userId?: string;
          meta?: Record<string, unknown>;
          tags?: readonly ContextApi.TagRef[];
        }>,
  ): void;

  /**
   * Refresh the idle timeout for one live connection. When the window passes
   * with no inbound frame the engine closes the socket as idle. Each call
   * replaces the previous window instead of stacking a second timer.
   *
   * Primitives such as `keepalive()` use this instead of reaching into the
   * engine's connection map directly.
   */
  refreshConnectionIdleTimeout(connectionId: string, timeoutMs: number): void;

  /**
   * Send one bare `ping` text frame to a live connection, doing nothing when
   * that connection has already gone away. Returns whether the frame was
   * actually sent, so a caller can stop acting on a connection that is gone.
   *
   * Only `keepalive()` may call this. A `pong` carries no id, so the only way
   * to know which ping it answers is for one thing to be sending them. A second
   * sender makes `keepalive()` time the wrong ping and report a wrong
   * `ctx.latency`.
   */
  sendPing(connectionId: string): boolean;

  /**
   * Record a measured round-trip time against one connection so it surfaces as
   * `ctx.latency` / `ctx.quality` and on every `ConnectionInfo`. Only
   * `keepalive()` measures a round-trip, so only `keepalive()` calls this.
   *
   * @internal
   */
  setConnectionLatency(
    connectionId: string,
    latency: number | null,
    quality: EngineRuntimeTypes.RuntimeConnection['quality'],
  ): void;

  /**
   * Build the context for one live connection, or `undefined` when it has gone
   * away. The `onPing` / `onPong` lifecycle primitives use this to hand the app
   * a real `ctx` rather than a bare connection id.
   *
   * @internal
   */
  getConnectionContext(connectionId: string): unknown;

  /**
   * Observe a bare `ping` frame arriving from a client. The engine registers
   * its own reply hook first, so by the time a handler added here runs, the
   * client has already been answered with `pong`.
   */
  onPing(handler: (connectionId: string) => void | Promise<void>): void;

  /**
   * Observe a bare `pong` frame arriving from a client — the client's reply to
   * a ping the server sent. `keepalive()` registers here during capability
   * setup, so its measurement lands before any handler the app adds.
   */
  onPong(handler: (connectionId: string) => void | Promise<void>): void;

  /**
   * Register an app-level `base.onPing` hook. Kept apart from `onPing` so the
   * dispatch runs the app after the engine, `keepalive()`, and any plugin
   * observers — the capability → plugin → app order. Used by the `onPing`
   * lifecycle primitive; a capability registers with `onPing` instead.
   */
  onAppPing(handler: (connectionId: string) => void | Promise<void>): void;

  /** Register an app-level `base.onPong` hook. Runs last, for the same reason. */
  onAppPong(handler: (connectionId: string) => void | Promise<void>): void;

  /**
   * Release whatever a capability holds for one connection, once it has closed.
   *
   * This runs inside the engine's own teardown, after every `disconnect` hook,
   * and cannot be skipped by a user hook that throws. Register per-connection
   * timers and map entries for release here rather than in `onDisconnect`.
   */
  onConnectionCleanup(handler: (connectionId: string) => void): void;

  /**
   * Access the engine's in-memory table of queued scheduled runs.
   */
  getScheduledRuns(): Map<string, ScheduledPrimitive.ScheduledRun>;

  /**
   * Access the engine's in-memory dead-letter queue for scheduled runs.
   */
  getScheduledDlq(): Map<string, ScheduledPrimitive.ScheduledDeadLetter>;

  /**
   * Queue one future scheduled task run. Backs `ctx.schedule(...)`, registered
   * by the `scheduled()` capability so a server without it has no such surface.
   *
   * @internal
   */
  scheduleTask(taskId: string, time: number, data: unknown): void;

  /**
   * Remove queued runs for one scheduled task id, optionally filtered. Backs
   * `ctx.cancelScheduled(...)`, registered by the `scheduled()` capability.
   *
   * @internal
   */
  cancelScheduled(
    taskId: string,
    filter?: Record<string, unknown>,
  ): ScheduledPrimitive.ScheduledCancelResult;

  /**
   * Look up one declared scheduled task by task id.
   */
  getScheduledTask(taskId: string): EngineCompileTypes.AnyScheduled | undefined;

  /**
   * Read every declared scheduled task.
   */
  getScheduledTasks(): Iterable<EngineCompileTypes.AnyScheduled>;

  /**
   * Build the runtime task context object used when scheduled work runs.
   *
   * It is returned as `unknown` here on purpose so primitive setup code does
   * not depend on a concrete engine context type.
   */
  createTaskContext(): unknown;

  /**
   * Send one replay message to a live connection with explicit wire metadata.
   *
   * Primitives use this to resend history without re-running the normal
   * outgoing pipeline. Unlike `rawSend`, this routes through the replay
   * pipeline and applies `onBeforeSend` / `onAfterSend` hooks.
   */
  sendReplay(connectionId: string, options: OptionsParameter): void;

  /**
   * Send a `__gap__` frame to one connection. `missedThrough` is the scope's
   * eviction watermark (highest seq retention deleted). @internal
   */
  sendGap(connectionId: string, options: OptionsParameter2): void;

  /**
   * Validate that a `ctx.sendReplay(...)` call satisfies the same contract
   * as a normal `ctx.send(...)`: the payload is a plain object and the event
   * is declared in the routing scope. Used by the replay primitive to enforce
   * the public-API contract before forwarding to `sendReplay`. The
   * replay-from-storage path stays trusted because rows were validated when
   * written.
   */
  assertReplaySendContract(
    event: string,
    payload: unknown,
    routing: { channel?: string; channelFamily?: string | null } | undefined,
  ): asserts payload is Record<string, unknown>;

  /**
   * Recompute the next scheduled callback from the current scheduled-run table.
   */
  rescheduleAlarm(): void;

  /**
   * Create a framework-generated id.
   *
   * This is usually used for tasks, streams, or other internal runtime
   * bookkeeping.
   */
  generateId(prefix?: string): string;

  /**
   * Send one raw protocol event directly to a live connection by id.
   *
   * This bypasses the normal typed ctx helpers and skips `onOutgoing` /
   * `onBeforeSend` / `onAfterSend` hooks — used for protocol messages
   * that should not go through the replay pipeline. For replay resends, use
   * `sendReplay` instead.
   */
  rawSend(connectionId: string, event: string, payload: unknown): void;

  /**
   * Like `rawSend`, but carries a `__wskit` routing block (channel scope,
   * correlationId) on the frame. Used to answer a scoped, correlated protocol
   * query — e.g. `inbox()` replying to a `__receivedQuery__` on one connection.
   *
   * @internal
   */
  sendProtocolFrame(connectionId: string, options: OptionsParameter3): void;

  /**
   * Register the plain-stream trigger so the dispatch hub can start a matched
   * `stream(...)` without importing its runtime. Set by the `stream()`
   * capability.
   *
   * @internal
   */
  setStreamTrigger(trigger: FeatureSlots.StreamTrigger): void;

  /**
   * Register the active-stream nudge buffer and cancel, shared by plain and
   * durable streams. Either stream kind sets it, so the owner registers it
   * through `installOnce` to keep it set exactly once.
   *
   * @internal
   */
  setActiveStreamOps(
    buffer: FeatureSlots.StreamNudgeBuffer,
    cancel: FeatureSlots.StreamCancel,
  ): void;

  /**
   * Register the durable-stream dispatch surface (trigger, resume, cancel,
   * schema). Set once when either `resumableStream()` or `recordedStream()` is
   * listed.
   *
   * @internal
   */
  setDurableStreamService(service: FeatureSlots.DurableStreamService): void;

  /**
   * Register the request dispatcher so the hub can run a matched `request(...)`
   * without importing its runtime. Set by the `serverRequests()` capability.
   *
   * @internal
   */
  setRequestDispatch(dispatch: FeatureSlots.RequestDispatch): void;

  /**
   * Register the `ctx.tags` builder so the connection context can expose the tag
   * surface without importing the tag runtime. Set by the `tags()` capability.
   *
   * @internal
   */
  setBuildTagsApi(build: FeatureSlots.BuildTagsApi): void;

  /**
   * Register the durable channel-membership operations. Set by the
   * `channels()` capability so storage code stays out of a bare handler.
   *
   * @internal
   */
  setChannelMembershipService(service: FeatureSlots.ChannelMembershipService): void;

  /**
   * Register the persistent-tag restore operation. Set by the `tags()`
   * capability so tag storage code stays out of a bare handler.
   *
   * @internal
   */
  setTagPersistenceService(service: FeatureSlots.TagPersistenceService): void;

  /**
   * Register the scheduled-task runtime. Set by `scheduled()` and by durable
   * streams (their retention sweep is a scheduled task) so the scheduler stays
   * out of a handler that uses neither.
   *
   * @internal
   */
  setScheduledService(service: FeatureSlots.ScheduledService): void;

  /**
   * Register the intercept pipeline runner. Set by the `intercepts()` capability
   * so a handler without it skips the intercept block and never bundles the
   * pipeline. The `ctx.matches` / `ctx.unsafeCast` frame matchers are core and
   * always present, so they are not registered here.
   *
   * @internal
   */
  setInterceptRuntime(runIntercepts: FeatureSlots.RunIntercepts): void;

  /**
   * Register the channel subscribe/leave/kick runtime. Set by the `channels()`
   * capability so a handler without it never bundles the membership-protocol
   * engine or the subscribe/unsubscribe frame handlers.
   *
   * @internal
   */
  setChannelService(service: FeatureSlots.ChannelService): void;

  /**
   * Register the `ctx.channels` / `ctx.channel` surface builders. Set by the
   * `channels()` capability so the connection context exposes the channel
   * accessor without the engine importing the channel-context module.
   *
   * @internal
   */
  setChannelContext(context: FeatureSlots.ChannelContext): void;

  /**
   * Register the inbox fan-out / drain / clear runtime. Set by the `inbox()`
   * capability so a handler without it never bundles the inbox storage or
   * per-member delivery code.
   *
   * @internal
   */
  setInboxService(service: FeatureSlots.InboxService): void;

  /**
   * Register the last-seen surface so other capabilities (inbox backlog, channel
   * member data) can read a member's last-seen timestamp and whether it is online
   * now, without importing the last-seen runtime. Set by the `lastSeen()` capability.
   *
   * @internal
   */
  setLastSeenService(service: FeatureSlots.LastSeenService): void;

  /**
   * Read the registered last-seen surface, or `undefined` when `lastSeen()` is
   * not listed. `inbox().backlog()` reads it to fill `lastSeenAt`.
   *
   * @internal
   */
  getLastSeenService(): FeatureSlots.LastSeenService | undefined;

  /**
   * Register a channel-handle augmenter. Set by capabilities that graft a
   * per-channel surface onto every channel handle (inbox, read receipts), so
   * `channels()` never value-imports them.
   *
   * @internal
   */
  addChannelHandleAugmenter(augmenter: FeatureSlots.ChannelHandleAugmenter): void;

  /**
   * Whether any live connection on this instance currently belongs to the
   * given user id. Read by inbox backlog and the last-seen surface to report
   * a member's online state without scanning the connection map themselves.
   *
   * @internal
   */
  isUserOnline(userId: string): boolean;

  /**
   * The identity of one live connection by id, or `undefined` when no such
   * connection is live on this instance. Read by the `lastSeen()` capability's
   * activity stamp, which only gets a connection id.
   *
   * @internal
   */
  getConnectionIdentity(connectionId: string): string | undefined;

  /**
   * Broadcast one already-built protocol frame (e.g. a `__received__` /
   * `__read__` receipt fan-out) to every live member of a channel. Offline
   * members are not reached — the frame is a live presence signal, and the
   * stored cursor stays readable either way.
   *
   * @internal
   */
  broadcastToChannel(opts: OptsParameter2): void;

  /**
   * Count the live members currently in a channel. Used to skip the
   * delivered/read receipt fan-out once a channel is larger than `maxReceiptAudience`.
   *
   * @internal
   */
  channelMemberCount(channelName: string, channelFamily: string | null): number;

  /**
   * Read the resolved inbox settings for a channel key, or `undefined` when the
   * channel has no inbox. `readReceipts()` uses this to settle inbox rows with the
   * right delete/keep lifecycle when `__read__` advances the received mark.
   *
   * @internal
   */
  getInboxChannel(channelKey: string): FeatureSlots.ResolvedInboxOptions | undefined;

  /**
   * List the active static and dynamic inbox scopes. Used by boot cleanup to
   * discard rows left behind when a deployed contract removes an inbox scope.
   * Optional so older/test access doubles remain valid.
   *
   * @internal
   */
  getInboxChannelScopes?(): { staticNames: readonly string[]; familyKeys: readonly string[] };

  /**
   * Drop a member's cached inbox row count so the next write re-reads it from
   * storage. Backfill can make the cache too low; an ack, read-settlement, or
   * channel leave can make it too high after rows are removed. Optional: an
   * engine access without it (a test double) keeps no cache to invalidate.
   *
   * @internal
   */
  invalidateInboxMemberCount?(
    channelName: string,
    channelFamily: string | null,
    userId: string,
  ): void;

  /**
   * The per-instance receipt-cursor cache, so an ack can skip re-reading a
   * member's cursor before advancing it. Optional: an engine access without it
   * (a test double) falls back to reading the cursor from storage.
   *
   * @internal
   */
  receiptCursorCache?(): Map<string, { receivedThrough: number; readThrough: number }>;

  /**
   * Whether a channel key opted into read receipts via `readReceipts()`. Read by
   * the read-receipts handle-augmenter to decide whether `handle.readReceipts()`
   * returns a surface or `null`.
   *
   * @internal
   */
  hasReadReceiptsChannel(channelKey: string): boolean;
}
