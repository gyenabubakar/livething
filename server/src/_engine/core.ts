import {
  ChannelNotFound,
  ChannelNotSubscribed,
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
import type * as EngineRuntimeTypes from '~/_engine/runtime/types.ts';
import type * as PublicApi from '~/context.ts';
import type * as PrimitiveCore from '~/primitive.ts';
import type * as ScheduledPrimitiveTypes from '~/scheduled/types.ts';
import type * as DefineServer from '~/server-definition.ts';
import type { Validator } from '~/types.ts';

type RuntimeConnection = EngineRuntimeTypes.RuntimeConnection;
type PluginRuntime = EngineRuntimeTypes.PluginRuntime;
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

  readonly hooks: EngineRuntimeTypes.RegisteredEngineHooks = createRegisteredHooks();

  storage?: PublicApi.StorageProvider;
  env: Record<string, unknown>;
  timers?: PublicApi.TimerProvider;
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
   * Ping interval (ms) for the per-connection keepalive ping, set by
   * `keepalive()` to the configured `pingIntervalMs`. `undefined` means no
   * keepalive was configured — the ping falls back to its built-in default.
   */
  keepalivePingIntervalMs: number | undefined = undefined;
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

  alarmHandle: unknown = null;
  idCounter = 0;
  readonly instanceNonce = Math.random().toString(36).slice(2, 8);
  /**
   * Async-context capability from the adapter. Tracks the connection whose
   * dispatch is on the async call stack; read by a plugin's `getState()`.
   */
  asyncContext: EngineAsyncContext;

  constructor(handler: DefineServer.ServerDefinition, options: EngineAdapterTypes.EngineOptions) {
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
    this.compiled = EngineCompile.compileHandlerDefinition(handler);
    this.storage = options.storage;
    this.env = options.env;
    this.timers = options.timers;
    this.platform = options.platform;
    this.waitUntilImpl = options.waitUntil;
    this.logger = options.logger;
    this.asyncContext = createAsyncContext(options.asyncContextFactory);
  }

  setInstanceId(id: string): void {
    this.engineInstanceId = id;
  }

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
   * Does a `(channelName, channelScope)` pair from a durable row still match a
   * persistent channel? Used by boot reconcile to find orphan rows from
   * removed or `persistent: false` channels.
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
