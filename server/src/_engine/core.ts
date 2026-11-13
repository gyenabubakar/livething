import {
  ChannelNotFound,
  ChannelNotSubscribed,
  ConnectionBusy,
  CrossInstanceRef,
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
  UploadAborted,
  ValidationFailed,
  WrongFrameKind,
} from '@livething/core';
import { createAsyncContext, getInvocationScope } from '~/_engine/async-context.ts';
import * as EngineCompile from '~/_engine/compile/compile.ts';
import { createRegisteredHooks } from '~/_engine/registry/hooks.ts';
import {
  createEngineStorage,
  createEngineTimers,
  UserTransactionTracker,
} from '~/_engine/user-transaction.ts';
import { assertPositiveInteger } from '~/_engine/validation.ts';
import type * as EngineAdapterTypes from '~/_adapters/types.ts';
import type { EngineAsyncContext, PendingScopeFlush } from '~/_engine/async-context.ts';
import type * as EngineCompileTypes from '~/_engine/compile/types.ts';
import type * as ConnectionStore from '~/_engine/runtime/connection-store.ts';
import type * as FeatureSlots from '~/_engine/runtime/feature-slots.ts';
import type * as EngineRuntimeTypes from '~/_engine/runtime/types.ts';
import type * as PublicApi from '~/context.ts';
import type * as PrimitiveCore from '~/primitive.ts';
import type * as ScheduledPrimitiveTypes from '~/scheduled/types.ts';
import type * as ServerTypes from '~/server-definition.ts';
import type { Validator } from '~/types.ts';

type RuntimeConnection = EngineRuntimeTypes.RuntimeConnection;
type ActiveStream = EngineRuntimeTypes.ActiveStream;
type Primitive = PrimitiveCore.Primitive;

/** How many purged users `isUserPurging` remembers for handlers that started before their purge. */
const MAX_PURGE_RECORDS = 10_000;

/** The message limit when the adapter gives none: Cloudflare's, so Node behaves the same. */
const DEFAULT_MESSAGE_BYTES = 32 * 1024 * 1024;

function resolveMessageLimits(
  options: EngineAdapterTypes.EngineOptions,
): EngineAdapterTypes.MessageLimits {
  const limits = options.messageLimits ?? {
    receiveBytes: DEFAULT_MESSAGE_BYTES,
    sendBytes: DEFAULT_MESSAGE_BYTES,
  };
  for (const field of ['receiveBytes', 'sendBytes'] as const) {
    assertPositiveInteger(
      limits[field],
      `messageLimits.${field}`,
      `Adapter "${options.adapterId}"`,
    );
  }

  return { receiveBytes: limits.receiveBytes, sendBytes: limits.sendBytes };
}

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

  /** Redoes the engine's own writes, alarm changes and `ctx.kv` writes when a user's `ctx.sql.transaction(...)` rolls back. */
  readonly userTransactions: UserTransactionTracker;

  /** The storage engine code uses. `ctx.sql` uses `options.storage` directly. */
  storage: PublicApi.StorageProvider;
  timers: PublicApi.TimerProvider;
  platform: unknown;
  logger: PublicApi.Logger;
  /** The adapter's message limits, with the 32 MiB defaults filled in. */
  messageLimits: EngineAdapterTypes.MessageLimits;

  /**
   * Engine id for multi-instance setups. Adapters that expose more than one
   * addressable engine set this before accepting connections so refs cannot
   * be mistaken for refs from another engine. `undefined` is reserved for
   * adapters that truly have one addressable engine.
   */
  engineInstanceId: string | undefined;

  hibernationEnabled = false;
  /** The ping and idle timings `keepalive()` gave at setup, for the `__connected__` frame. */
  keepaliveTimings: { pingIntervalMs: number; idleTimeoutMs: number } | null = null;
  replayEnabled = false;
  sequencePersistent = false;
  incomingDedupCap = 0;

  /**
   * Runtime dispatch slots filled by feature capabilities during `__setup`. The
   * dispatch hub calls a feature's runtime only through these, so a handler that
   * never lists a feature never pulls its runtime into the bundle.
   */
  streamTrigger?: FeatureSlots.StreamTrigger;
  streamNudgeBuffer?: FeatureSlots.StreamNudgeBuffer;
  streamCancel?: FeatureSlots.StreamCancel;
  streamChannelLeave?: FeatureSlots.StreamChannelLeave;
  durableStream?: FeatureSlots.DurableStreamService;
  uploadService?: FeatureSlots.UploadService;
  requestDispatch?: FeatureSlots.RequestDispatch;
  binaryService?: FeatureSlots.BinaryService;
  buildTagsApi?: FeatureSlots.BuildTagsApi;
  channelMembershipService?: FeatureSlots.ChannelMembershipService;
  tagPersistenceService?: FeatureSlots.TagPersistenceService;
  scheduledService?: FeatureSlots.ScheduledService;
  channelService?: FeatureSlots.ChannelService;
  channelContext?: FeatureSlots.ChannelContext;
  inboxService?: FeatureSlots.InboxService;
  lastSeenService?: FeatureSlots.LastSeenService;
  /** Hands out the next delivery seq. Set by `sequence()`, shared with every send. */
  allocateDeliverySeq?: () => number;

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

  /** Per-channel `membership` overrides. Explicit `'persistent'` opts in. */
  readonly channelDurabilityOverrides = new Map<string, boolean>();

  /**
   * Resolved inbox settings per channel key, populated by the `inbox()`
   * capability during setup. A channel key present here has inbox enabled.
   */
  readonly inboxChannels = new Map<string, FeatureSlots.ResolvedInboxOptions>();

  /** Channel keys that opted into read receipts via `readReceipts()`. */
  readonly readReceiptsChannels = new Set<string>();

  /**
   * In-memory mirror of each member's receipt cursors, keyed by channel and
   * identity. Cursors advance monotonically during a live instance and are
   * cleared when their durable rows are purged, so an ack can skip the read
   * before its write without surviving a user purge. A hibernation wake starts
   * empty and re-seeds from storage on first touch.
   */
  readonly inboxReceiptCursors = new Map<
    string,
    { receivedThrough: number; readThrough: number }
  >();

  /**
   * In-memory count and byte total of each member's inbox rows, keyed by channel and
   * identity. Seeded from storage on first touch and bumped as fan-out writes rows, so the
   * per-member retention prune runs only when the row or byte cap could be exceeded. It
   * is invalidated when rows are acknowledged, backfilled, cleared or pruned, and an
   * undercount only keeps a few rows past the cap until the next prune.
   */
  readonly inboxMemberCounts = new Map<string, { rows: number; bytes: number }>();

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
    // The engine's own fallback code for any non-LiveThingError. It is always a
    // valid code to surface, so declaring it here keeps an explicit
    // `throw InternalError()` from logging a spurious "not declared" warning.
    InternalError.code,
    ValidationFailed.code,
    ChannelNotFound.code,
    ChannelNotSubscribed.code,
    CrossInstanceRef.code,
    DurableStreamRequiresUser.code,
    RateLimited.code,
    ConnectionBusy.code,
    RejoinRejected.code,
    RequestNoCorrelation.code,
    RequestNoResponse.code,
    StreamAborted.code,
    StreamAlreadyActive.code,
    StreamIdCollision.code,
    UnsupportedProtocol.code,
    UploadAborted.code,
    WrongFrameKind.code,
  ]);

  /** How many `purgeUser` calls are running, per user. Use `isUserPurging` to ask about a user. */
  private readonly runningPurges = new Map<string, number>();

  /** Counts `purgeUser` calls. An invocation scope keeps the value it started with. */
  purgeEpoch = 0;

  /** The epoch of each user's latest purge, oldest purge first, at most `MAX_PURGE_RECORDS`. */
  readonly lastPurgeEpochs = new Map<string, number>();

  readonly connections = new Map<string, RuntimeConnection>();
  // User-key → members index (fan-out for `ctx.user`/`ctx.users`, and total-user
  // lookups), maintained on accept, close, and hibernation wake.
  readonly usersByKey = new Map<string, Set<RuntimeConnection>>();
  // Channel-key → members index, so broadcasts skip a full connections scan.
  readonly channelMembers = new Map<string, Set<RuntimeConnection>>();
  // Tag-key → members index, so tag fan-out skips a full connections scan.
  readonly tagMembers = new Map<string, Set<RuntimeConnection>>();
  readonly socketToConnectionId = new Map<unknown, string>();
  readonly activeStreams = new Map<string, ActiveStream>();
  readonly scheduledRuns = new Map<string, ScheduledPrimitiveTypes.ScheduledRun>();

  // Mirror of the durable run table: maps from row id to a stable signature of
  // the columns last written. The scheduler diffs the current in-memory queue
  // against it to emit one targeted INSERT/UPDATE/DELETE per changed row
  // instead of rewriting the whole table on each persist.
  readonly scheduledRunsPersisted = new Map<string, string>();
  /** Framework-owned alarm sources. The adapter exposes one durable alarm. */
  readonly alarmSources = new Map<symbol, () => number | null>();
  readonly installedFeatures = new Set<symbol>();
  /** Background work started by the engine that must settle before storage closes. */
  readonly backgroundWork = new Set<Promise<void>>();

  /**
   * Every persisted connection row, read in one query for the duration of the
   * boot restore pass. Unset at every other moment, when a wake reads its own
   * row live.
   */
  preloadedConnectionRows: Map<string, ConnectionStore.StoredConnectionRow> | undefined;

  idCounter = 0;
  readonly instanceNonce = Math.random().toString(36).slice(2, 8);
  /**
   * Async-context capability from the adapter. Tracks the connection whose
   * dispatch is on the async call stack; read by a plugin's `getState()`.
   */
  asyncContext: EngineAsyncContext;
  /** Snapshot writes queued by open invocation scopes, one entry per row key. */
  readonly pendingSnapshotFlushes = new Map<string, PendingScopeFlush>();

  constructor(definition: ServerTypes.ServerDefinition, options: EngineAdapterTypes.EngineOptions) {
    if (options.storage === undefined) {
      throw new Error(`[livething] Adapter "${options.adapterId}" did not provide storage.`);
    }

    if (options.timers === undefined) {
      throw new Error(`[livething] Adapter "${options.adapterId}" did not provide timers.`);
    }

    if (options.platform === undefined) {
      throw new Error(`[livething] Adapter "${options.adapterId}" did not provide platform.`);
    }

    if (options.logger === undefined) {
      throw new Error(`[livething] Adapter "${options.adapterId}" did not provide logger.`);
    }

    if (options.asyncContextFactory === undefined) {
      throw new Error(
        `[livething] Adapter "${options.adapterId}" did not provide async-context support.`,
      );
    }

    this.options = options;
    this.primitives = definition.primitives;
    this.adminApiFactory = (
      definition as { __apiFactory?: (ctx: unknown) => unknown }
    ).__apiFactory;
    this.compiled = EngineCompile.compileServerDefinition(definition);

    this.platform = options.platform;
    this.logger = options.logger;
    this.messageLimits = resolveMessageLimits(options);
    this.userTransactions = new UserTransactionTracker(
      (error) => {
        this.logger.error('[livething] could not redo a storage write after a rollback', {
          error: error instanceof Error ? error.message : String(error),
        });
      },
      options.asyncContextFactory,
      (error) => this.logger.error(error.message),
    );
    this.storage = createEngineStorage(options.storage, this.userTransactions);

    this.timers = createEngineTimers(options.timers, this.userTransactions);

    this.asyncContext = createAsyncContext(options.asyncContextFactory, definition.__baseId);

    this.hooks.ping.push((connectionId) => this.replyPong(connectionId));
  }

  /**
   * Answer a client's `ping` with a `pong`. Registered as the engine's own
   * first ping hook, ahead of anything a capability or the app adds, because a
   * client measuring the server expects a reply from every server — sending
   * pings is what `keepalive()` owns, answering them is not.
   */
  private replyPong(connectionId: string): void {
    this.connections.get(connectionId)?.descriptor.send({ kind: 'text', text: 'pong' });
  }

  setInstanceId(id: string): void {
    this.engineInstanceId = id;
  }

  generateId(prefix = 'id'): string {
    this.idCounter += 1;
    return `${prefix}_${this.instanceNonce}_${this.idCounter}`;
  }

  /** @internal */
  trackBackgroundWork(work: Promise<void>): void {
    this.backgroundWork.add(work);
    void work.then(
      () => this.backgroundWork.delete(work),
      () => this.backgroundWork.delete(work),
    );
  }

  /** @internal */
  async drainBackgroundWork(): Promise<void> {
    while (this.backgroundWork.size > 0) {
      await Promise.allSettled([...this.backgroundWork]);
    }
  }

  usesHibernation(): boolean {
    return this.hibernationEnabled;
  }

  usesTags(): boolean {
    return this.tagGroupsRegistered.ephemeral || this.tagGroupsRegistered.persistent;
  }

  /** Start a purge: from now on, nothing may write this user's durable rows. */
  markUserPurging(userId: string): void {
    this.runningPurges.set(userId, (this.runningPurges.get(userId) ?? 0) + 1);
    this.purgeEpoch += 1;
    this.lastPurgeEpochs.delete(userId);
    this.lastPurgeEpochs.set(userId, this.purgeEpoch);
    // The record stays bounded by forgetting the oldest purge. A handler that
    // outlives MAX_PURGE_RECORDS later purges can therefore still write its user's rows.
    if (this.lastPurgeEpochs.size > MAX_PURGE_RECORDS) {
      const [oldest] = this.lastPurgeEpochs.keys();
      this.lastPurgeEpochs.delete(oldest!);
    }
  }

  /** End one purge. The user stays guarded until every overlapping purge has ended. */
  unmarkUserPurging(userId: string): void {
    const running = this.runningPurges.get(userId) ?? 0;
    if (running > 1) this.runningPurges.set(userId, running - 1);
    else this.runningPurges.delete(userId);
  }

  /**
   * Whether the running code must not write this user's durable rows: a purge is
   * running, or the running invocation started before the user's latest purge. An
   * invocation that started after it (the same user id signing in again) may write.
   */
  isUserPurging(userId: string): boolean {
    if (this.runningPurges.has(userId)) return true;

    const purgedAt = this.lastPurgeEpochs.get(userId);
    if (purgedAt === undefined) return false;

    const scope = getInvocationScope(this.asyncContext);

    return scope !== null && scope.purgeEpoch < purgedAt;
  }

  isChannelDurable(channelKey: string): boolean {
    return this.channelDurabilityOverrides.get(channelKey) === true;
  }

  isTagGroupDeclared(kind: 'ephemeral' | 'persistent', group: string): boolean {
    return this.declaredTagGroups[kind].has(group);
  }

  /** The runtime validator for a tag group, or `undefined` when it has none. */
  getTagGroupSchema(kind: 'ephemeral' | 'persistent', group: string): Validator | undefined {
    return this.tagGroupSchemas.get(`${kind}:${group}`);
  }

  /**
   * Does a `(channelName, channelFamily)` pair from a durable row still match a
   * durable channel? Used by boot reconcile to find orphan rows from
   * channels that were removed or are no longer `membership: 'persistent'`.
   */
  isDurableMembershipPairDurable(channelName: string, channelFamily: string | null): boolean {
    if (channelFamily === null) {
      const channel = this.compiled.channels.get(channelName);
      return channel ? this.isChannelDurable(channel.key) : false;
    }

    const family = this.compiled.channelFamilies.get(channelFamily);
    return family ? this.isChannelDurable(family.key) : false;
  }
}
