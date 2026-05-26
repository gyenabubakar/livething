import {
  ChannelNotFound,
  ChannelNotSubscribed,
  InvalidScopeMarkers,
  NamespaceNotFound,
  RateLimited,
  StreamAborted,
  StreamAlreadyActive,
  StreamIdCollision,
  ValidationFailed,
} from '@wskit/core';
import * as EngineCompile from '~/_engine/compile/compile.ts';
import { createRegisteredHooks } from '~/_engine/registry/hooks.ts';
import type * as EngineAdapterTypes from '~/_adapters/types.ts';
import type * as EngineCompileTypes from '~/_engine/compile/types.ts';
import type * as EngineRuntimeTypes from '~/_engine/runtime/types.ts';
import type * as PublicApi from '~/context.ts';
import type * as PrimitiveCore from '~/primitive.ts';
import type * as ReplayPrimitiveTypes from '~/replay/types.ts';
import type * as ScheduledPrimitiveTypes from '~/scheduled/types.ts';
import type * as DefineServer from '~/server-definition.ts';

type RuntimeConnection = EngineRuntimeTypes.RuntimeConnection;
type PluginRuntime = EngineRuntimeTypes.PluginRuntime;
type ActiveStream = EngineRuntimeTypes.ActiveStream;
type Primitive = PrimitiveCore.Primitive;

/**
 * Holds every piece of state one engine needs at runtime. No behaviour —
 * runtime plugins read and write these fields directly.
 */
export class EngineCore {
  // ─────── compiled handler + primitive tree ───────

  readonly options: EngineAdapterTypes.EngineOptions;
  readonly primitives: readonly Primitive[];
  readonly compiled: EngineCompileTypes.CompiledServer;

  // ─────── hook registries ───────

  readonly hooks: EngineRuntimeTypes.RegisteredEngineHooks = createRegisteredHooks();

  // ─────── adapter-provided dependencies ───────

  storage?: PublicApi.StorageProvider;
  env: Record<string, unknown> = {};
  timers?: PublicApi.TimerProvider;
  platform: unknown = {};
  waitUntilImpl: (promise: Promise<unknown>) => void = () => {};
  hasWaitUntil = false;
  logger: PublicApi.Logger = {
    info(message: string, data?: unknown) {
      console.log(message, data ?? {});
    },
    warn(message: string, data?: unknown) {
      console.warn(message, data ?? {});
    },
    error(message: string, data?: unknown) {
      console.error(message, data ?? {});
    },
  };

  /**
   * Engine id for multi-instance setups. `undefined` means single-instance —
   * every local ref carries `undefined` and the broker is skipped. Adapters
   * with a broker call `setInstanceId(...)` so refs carry a real id.
   */
  engineInstanceId: string | undefined;

  // ─────── feature flags set during primitive setup ───────

  hibernationEnabled = false;
  replayEnabled = false;
  sequencePersistent = false;
  /** Set by `persistence: true`. Turns on durable tables and membership writes. */
  persistenceEnabled = false;
  incomingDedupCap = 0;
  initialized = false;
  /**
   * True after a cold-boot schema run (first wake with no prior schema). The
   * first `autoRejoinIdentity` call clears it so subsequent connections query
   * normally.
   */
  freshBoot = false;

  /** Per-channel `persistent` overrides. Explicit `false` opts out. */
  readonly channelPersistenceOverrides = new Map<string, boolean>();

  /** Tag groups declared via the contract's `tagGroups` config. Empty when none are declared. */
  readonly declaredTagGroups = {
    ephemeral: new Set<string>(),
    persistent: new Set<string>(),
  };
  readonly tagGroupsRegistered = { ephemeral: false, persistent: false };

  readonly declaredErrorCodes = new Set<string>([
    ValidationFailed.code,
    ChannelNotFound.code,
    ChannelNotSubscribed.code,
    InvalidScopeMarkers.code,
    NamespaceNotFound.code,
    RateLimited.code,
    StreamAborted.code,
    StreamAlreadyActive.code,
    StreamIdCollision.code,
  ]);

  // ─────── runtime maps ───────

  readonly connections = new Map<string, RuntimeConnection>();
  // Channel-key → members index, so broadcasts skip a full connections scan.
  readonly channelMembers = new Map<string, Set<RuntimeConnection>>();
  // Tag-key → members index, so tag fan-out skips a full connections scan.
  readonly tagMembers = new Map<string, Set<RuntimeConnection>>();
  readonly wsToConnectionId = new Map<unknown, string>();
  readonly activeStreams = new Map<string, ActiveStream>();
  readonly scheduledRuns = new Map<string, ScheduledPrimitiveTypes.ScheduledRun>();
  readonly scheduledDlq = new Map<string, ScheduledPrimitiveTypes.ScheduledDeadLetter>();

  // Mirrors of the durable scheduler tables: maps from row id to a stable
  // signature of the columns last written. The scheduler diffs the current
  // in-memory queue against these maps to emit one targeted INSERT/UPDATE/DELETE
  // per changed row instead of rewriting the whole table on each persist.
  readonly scheduledRunsPersisted = new Map<string, string>();
  readonly scheduledDlqPersisted = new Map<string, string>();
  readonly installedFeatures = new Set<symbol>();
  readonly pluginRuntimes: PluginRuntime[] = [];

  // The engine sets this to an open scope object whenever it is busy
  // running one user-facing callback — a wskit handler responding to an
  // incoming WebSocket message, a WebSocket close, a WebSocket error, or
  // a scheduled callback fire. (The full list is the methods `wrapHandle`
  // wraps in `_engine/engine.ts`.) The scope closes when that callback
  // returns.
  //
  // While the scope is open the engine holds back two kinds of SQL writes
  // and does them all at the end of the callback instead of one by one as
  // they happen:
  //
  // - `dirtyConnections` collects connections whose hibernation row needs
  //   saving. A handler that joins five channels would normally save the
  //   row five times; with the scope it saves once at the end.
  //
  // - `pendingReplaySnapshotRows` collects snapshot-mode replay writes,
  //   grouped by the row key the snapshot maps to. When a later send in
  //   the same handler targets the same key, the new value replaces (or
  //   is merged with) the old one in memory. At the end of the callback
  //   each key writes one row. A `null` row means "delete this row at
  //   flush time" — that comes from a reducer that decided the key
  //   should no longer exist.
  //
  // `postFlush` is a clean-up callback the queue entry carries with it.
  // The scope flusher calls it right after writing the row. Replay uses
  // this to run its retention prune (drop the oldest rows, drop expired
  // rows) once the new row is actually on disk and counts toward the
  // limit.
  //
  // `null` here means no handler is currently running, so writes go
  // straight to SQL the moment they are asked for, the same as before
  // this batching layer existed.
  invocationScope: {
    dirtyConnections: Set<RuntimeConnection>;
    pendingReplaySnapshotRows: Map<
      string,
      {
        row: ReplayPrimitiveTypes.ReplayRow | null;
        postFlush: (sql: Pick<PublicApi.SQLProvider, 'exec'>) => void;
      }
    >;
  } | null = null;

  alarmHandle: unknown = null;
  idCounter = 0;
  readonly instanceNonce = Math.random().toString(36).slice(2, 8);
  /**
   * Async-context capability from the adapter. Tracks the connection whose
   * dispatch is on the async call stack; read by a plugin's `getState()`.
   */
  asyncContext?: PublicApi.AsyncContext;

  constructor(handler: DefineServer.ServerDefinition, options: EngineAdapterTypes.EngineOptions) {
    this.options = options;
    this.primitives = handler.primitives;
    this.compiled = EngineCompile.compileHandlerDefinition(handler);
  }

  // ─────── setters ───────

  setStorage(storage: PublicApi.StorageProvider): void {
    this.storage = storage;
  }

  setEnv(env: Record<string, unknown>): void {
    this.env = env;
  }

  setTimerProvider(timers: PublicApi.TimerProvider): void {
    this.timers = timers;
  }

  setPlatform(platform: unknown): void {
    this.platform = platform;
  }

  setAsyncContext(asyncContext: PublicApi.AsyncContext): void {
    this.asyncContext = asyncContext;
  }

  setWaitUntil(waitUntil: (promise: Promise<unknown>) => void): void {
    this.hasWaitUntil = true;
    this.waitUntilImpl = waitUntil;
  }

  setLogger(logger: PublicApi.Logger): void {
    this.logger = logger;
  }

  setInstanceId(id: string): void {
    this.engineInstanceId = id;
  }

  // ─────── dependency accessors ───────

  storageOrUndefined(): PublicApi.StorageProvider | undefined {
    return this.storage;
  }

  requireStorage(): PublicApi.StorageProvider {
    if (!this.storage) {
      throw new Error(`[wskit] storage not provided by adapter "${this.options.adapterId}".`);
    }
    return this.storage;
  }

  requireTimers(): PublicApi.TimerProvider {
    if (!this.timers) {
      throw new Error(`[wskit] timers not provided by adapter "${this.options.adapterId}".`);
    }
    return this.timers;
  }

  // ─────── id generation ───────

  generateId(prefix = 'id'): string {
    this.idCounter += 1;
    return `${prefix}_${this.instanceNonce}_${this.idCounter}`;
  }

  // ─────── feature-flag readers ───────

  usesHibernation(): boolean {
    return this.hibernationEnabled;
  }

  usesPersistence(): boolean {
    return this.persistenceEnabled;
  }

  usesTags(): boolean {
    return this.tagGroupsRegistered.ephemeral || this.tagGroupsRegistered.persistent;
  }

  isChannelPersistent(channelKey: string): boolean {
    if (!this.persistenceEnabled) return false;
    return this.channelPersistenceOverrides.get(channelKey) !== false;
  }

  isTagGroupDeclared(kind: 'ephemeral' | 'persistent', group: string): boolean {
    return this.declaredTagGroups[kind].has(group);
  }

  getDeclaredTagGroups(kind: 'ephemeral' | 'persistent'): ReadonlySet<string> {
    return this.declaredTagGroups[kind];
  }

  /**
   * Does a `(channelName, channelScope)` pair from a durable row still match a
   * persistent channel? Used by boot reconcile to find orphan rows from
   * removed or `.persistent(false)` channels.
   */
  isDurableMembershipPairPersistent(channelName: string, channelScope: string | null): boolean {
    if (!this.persistenceEnabled) return false;
    if (channelScope === null) {
      const channel = this.compiled.channels.get(channelName);
      return channel ? this.isChannelPersistent(channel.key) : false;
    }
    const family = this.compiled.channelFamilies.get(channelScope);
    return family ? this.isChannelPersistent(family.key) : false;
  }
}
