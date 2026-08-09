import {
  ChannelNotFound,
  ChannelNotSubscribed,
  DurableStreamRequiresUser,
  InternalError,
  RateLimited,
  RejoinRejected,
  RequestNoCorrelation,
  RequestNoResponse,
  StreamAborted,
  StreamAlreadyActive,
  StreamIdCollision,
  UnsupportedProtocol,
  ValidationFailed,
} from '@wskit/core';
import { createAsyncContext } from '~/_engine/async-context.ts';
import * as EngineCompile from '~/_engine/compile/compile.ts';
import { createRegisteredHooks } from '~/_engine/registry/hooks.ts';
import type * as EngineAdapterTypes from '~/_adapters/types.ts';
import type { EngineAsyncContext } from '~/_engine/async-context.ts';
import type * as EngineCompileTypes from '~/_engine/compile/types.ts';
import type * as FeatureSlots from '~/_engine/runtime/feature-slots.ts';
import type * as EngineRuntimeTypes from '~/_engine/runtime/types.ts';
import type * as PublicApi from '~/context.ts';
import type * as PrimitiveCore from '~/primitive.ts';
import type * as ScheduledPrimitiveTypes from '~/scheduled/types.ts';
import type * as DefineServer from '~/server-definition.ts';
import type { Validator } from '~/types.ts';

type RuntimeConnection = EngineRuntimeTypes.RuntimeConnection;
type ActiveStream = EngineRuntimeTypes.ActiveStream;
type Primitive = PrimitiveCore.Primitive;

/**
 * Holds every piece of state one engine needs at runtime. No behaviour —
 * runtime plugins read and write these fields directly.
 */
export class EngineCore {
  readonly options: EngineAdapterTypes.EngineOptions;
  readonly primitives: readonly Primitive[];
  readonly compiled: EngineCompileTypes.CompiledServer;

  /**
   * The app's top-level `api` factory, authored on `assemble({ handlers, api })`.
   * Reached connectionlessly through `Engine.admin()`. Undefined when no `api`
   * was declared.
   */
  readonly adminApiFactory?: (ctx: unknown) => unknown;

  readonly hooks: EngineRuntimeTypes.RegisteredEngineHooks = createRegisteredHooks();

  storage: PublicApi.StorageProvider;
  env: Record<string, unknown>;
  timers: PublicApi.TimerProvider;
  platform: unknown;
  waitUntilImpl: (promise: Promise<unknown>) => void;
  logger: PublicApi.Logger;

  /**
   * Engine id for multi-instance setups. `undefined` means single-instance —
   * every local ref carries `undefined` and the broker is skipped. Adapters
   * with a broker call `setInstanceId(...)` so refs carry a real id.
   */
  engineInstanceId: string | undefined;

  hibernationEnabled = false;
  replayEnabled = false;
  sequencePersistent = false;
  /** Set by `persistence: true`. Turns on durable tables and membership writes. */
  persistenceEnabled = false;
  incomingDedupCap = 0;

  /**
   * Runtime dispatch slots filled by feature capabilities during `__setup`. The
   * dispatch hub calls a feature's runtime only through these, so a handler that
   * never lists a feature never pulls its runtime into the bundle.
   */
  streamTrigger?: FeatureSlots.StreamTrigger;
  streamNudgeBuffer?: FeatureSlots.StreamNudgeBuffer;
  streamCancel?: FeatureSlots.StreamCancel;
  durableStream?: FeatureSlots.DurableStreamService;
  requestDispatch?: FeatureSlots.RequestDispatch;
  buildTagsApi?: FeatureSlots.BuildTagsApi;
  persistenceService?: FeatureSlots.PersistenceService;
  scheduledService?: FeatureSlots.ScheduledService;
  runIntercepts?: FeatureSlots.RunIntercepts;
  channelService?: FeatureSlots.ChannelService;
  channelContext?: FeatureSlots.ChannelContext;
  inboxService?: FeatureSlots.InboxService;
  lastSeenService?: FeatureSlots.LastSeenService;

  /**
   * Handle-augmenters registered by capabilities that own a per-channel surface
   * reachable from any channel handle (inbox, read receipts). `buildChannelHandle`
   * runs them so `channels()` never value-imports those capabilities.
   */
  readonly channelHandleAugmenters: FeatureSlots.ChannelHandleAugmenter[] = [];

  /**
   * The one `initialize()` run, in flight or settled. Held rather than a
   * boolean flag so concurrent callers join the same run instead of each
   * starting their own — a boolean set after the first await lies for as long
   * as init takes.
   */
  initPromise: Promise<void> | null = null;
  /**
   * True after a cold-boot schema run (first wake with no prior schema). The
   * first `autoRejoinIdentity` call clears it so subsequent connections query
   * normally.
   */
  freshBoot = false;

  /** Per-channel `persistent` overrides. Explicit `false` opts out. */
  readonly channelPersistenceOverrides = new Map<string, boolean>();

  /**
   * Resolved inbox settings per channel key, populated by the `inbox()`
   * capability during setup. A channel key present here has inbox enabled.
   */
  readonly inboxChannels = new Map<string, FeatureSlots.ResolvedInboxOptions>();

  /** Channel keys that opted into read receipts via `readReceipts()`. */
  readonly readReceiptsChannels = new Set<string>();

  /**
   * In-memory mirror of each member's receipt cursors, keyed by channel and
   * identity. Cursors are only ever advanced (never deleted), so this stays valid
   * for the instance lifetime and lets an ack skip the read before its write. A
   * hibernation wake starts empty and re-seeds from storage on first touch.
   */
  readonly inboxReceiptCursors = new Map<
    string,
    { receivedThrough: number; readThrough: number }
  >();

  /**
   * In-memory count of each member's inbox rows, keyed by channel and identity.
   * Seeded from storage on first touch and bumped as fan-out writes rows, so the
   * per-member retention prune runs only when the row cap could be exceeded. An
   * undercount just keeps a few rows past the cap until the next prune — never a
   * dropped or duplicated delivery — so it is safe to skip precise invalidation.
   */
  readonly inboxMemberCounts = new Map<string, number>();

  /** Tag groups declared via the contract's `tagGroups` config. Empty when none are declared. */
  readonly declaredTagGroups = {
    ephemeral: new Set<string>(),
    persistent: new Set<string>(),
  };
  readonly tagGroupsRegistered = { ephemeral: false, persistent: false };

  /**
   * Per-group runtime validators, keyed `${kind}:${group}`. Present only for
   * groups declared with a Standard Schema; groups declared with a `t<>()`
   * marker (or no type) have no entry and skip runtime validation.
   */
  readonly tagGroupSchemas = new Map<string, Validator>();

  /**
   * Per-connection API factories for plugins registered through the new
   * `plugin(...)` model, keyed by plugin id. `ctx.plugin(id)` runs the matching
   * factory against a plugin-scoped context. Empty when no such plugin is listed.
   */
  readonly pluginApiFactories = new Map<string, (ctx: unknown) => unknown>();

  readonly declaredErrorCodes = new Set<string>([
    // The engine's own fallback code for any non-WSKitError. It is always a
    // valid code to surface, so declaring it here keeps an explicit
    // `throw InternalError()` from logging a spurious "not declared" warning.
    InternalError.code,
    ValidationFailed.code,
    ChannelNotFound.code,
    ChannelNotSubscribed.code,
    DurableStreamRequiresUser.code,
    RateLimited.code,
    RejoinRejected.code,
    RequestNoCorrelation.code,
    RequestNoResponse.code,
    StreamAborted.code,
    StreamAlreadyActive.code,
    StreamIdCollision.code,
    UnsupportedProtocol.code,
  ]);

  readonly connections = new Map<string, RuntimeConnection>();
  // User-key → members index (fan-out for `ctx.user`/`ctx.users`, and total-user
  // lookups), maintained on accept, close, and hibernation wake.
  readonly usersByKey = new Map<string, Set<RuntimeConnection>>();
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

  idCounter = 0;
  readonly instanceNonce = Math.random().toString(36).slice(2, 8);
  /**
   * Async-context capability from the adapter. Tracks the connection whose
   * dispatch is on the async call stack; read by a plugin's `getState()`.
   */
  asyncContext: EngineAsyncContext;

  constructor(handler: DefineServer.ServerDefinition, options: EngineAdapterTypes.EngineOptions) {
    if (options.storage === undefined) {
      throw new Error(`[wskit] Adapter "${options.adapterId}" did not provide storage.`);
    }
    if (options.timers === undefined) {
      throw new Error(`[wskit] Adapter "${options.adapterId}" did not provide timers.`);
    }
    if (options.env === undefined) {
      throw new Error(`[wskit] Adapter "${options.adapterId}" did not provide env.`);
    }
    if (options.platform === undefined) {
      throw new Error(`[wskit] Adapter "${options.adapterId}" did not provide platform.`);
    }
    if (options.waitUntil === undefined) {
      throw new Error(`[wskit] Adapter "${options.adapterId}" did not provide waitUntil.`);
    }
    if (options.logger === undefined) {
      throw new Error(`[wskit] Adapter "${options.adapterId}" did not provide logger.`);
    }
    if (options.asyncContextFactory === undefined) {
      throw new Error(
        `[wskit] Adapter "${options.adapterId}" did not provide async-context support.`,
      );
    }

    this.options = options;
    this.primitives = handler.primitives;
    this.adminApiFactory = (handler as { __apiFactory?: (ctx: unknown) => unknown }).__apiFactory;
    this.compiled = EngineCompile.compileHandlerDefinition(handler);
    this.storage = options.storage;
    this.env = options.env;
    this.timers = options.timers;
    this.platform = options.platform;
    this.waitUntilImpl = options.waitUntil;
    this.logger = options.logger;
    this.asyncContext = createAsyncContext(options.asyncContextFactory);
    this.hooks.ping.push((connectionId) => this.replyPong(connectionId));
  }

  /**
   * Answer a client's `ping` with a `pong`. Registered as the engine's own
   * first ping hook, ahead of anything a capability or the app adds, because a
   * client measuring the server expects a reply from every server — sending
   * pings is what `keepalive()` owns, answering them is not.
   */
  private replyPong(connectionId: string): void {
    this.connections.get(connectionId)?.descriptor.send('pong');
  }

  setInstanceId(id: string): void {
    this.engineInstanceId = id;
  }

  generateId(prefix = 'id'): string {
    this.idCounter += 1;
    return `${prefix}_${this.instanceNonce}_${this.idCounter}`;
  }

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

  /** The runtime validator for a tag group, or `undefined` when it has none. */
  getTagGroupSchema(kind: 'ephemeral' | 'persistent', group: string): Validator | undefined {
    return this.tagGroupSchemas.get(`${kind}:${group}`);
  }

  getDeclaredTagGroups(kind: 'ephemeral' | 'persistent'): ReadonlySet<string> {
    return this.declaredTagGroups[kind];
  }

  /**
   * Does a `(channelName, channelFamily)` pair from a durable row still match a
   * persistent channel? Used by boot reconcile to find orphan rows from
   * removed or `persistent: false` channels.
   */
  isDurableMembershipPairPersistent(channelName: string, channelFamily: string | null): boolean {
    if (!this.persistenceEnabled) return false;
    if (channelFamily === null) {
      const channel = this.compiled.channels.get(channelName);
      return channel ? this.isChannelPersistent(channel.key) : false;
    }
    const family = this.compiled.channelFamilies.get(channelFamily);
    return family ? this.isChannelPersistent(family.key) : false;
  }
}
