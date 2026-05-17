/* oxlint-disable @typescript-eslint/no-explicit-any */
import {
  ChannelNotFound,
  ChannelNotSubscribed,
  CloseCodes,
  InternalError,
  InvalidScopeMarkers,
  NamespaceNotFound,
  StreamAborted,
  StreamAlreadyActive,
  ValidationFailed,
} from '@wskit/core';
import * as EngineCompile from '~/_engine/compile/compile.ts';
import { PROTOCOL_PAYLOAD_FIELDS } from '~/_engine/compile/utils.ts';
import * as EngineContexts from '~/_engine/contexts/contexts.ts';
import * as EngineDeps from '~/_engine/engine.deps.ts';
import * as ConnectionStore from '~/_engine/runtime/connection-store.ts';
import * as EngineConnectionRuntime from '~/_engine/runtime/connection.ts';
import * as EngineMessageRuntime from '~/_engine/runtime/messages.ts';
import * as ChannelPrimitive from '~/channel/runtime.ts';
import * as ErrorsPrimitive from '~/errors/runtime.ts';
import * as HeartbeatPrimitive from '~/heartbeat/runtime.ts';
import * as OutgoingRuntime from '~/outgoing/runtime.ts';
import { autoRejoinIdentity as runAutoRejoin } from '~/persistence/rejoin.ts';
import * as PersistenceStorage from '~/persistence/storage.ts';
import * as ScheduledPrimitive from '~/scheduled/runtime.ts';
import { scheduled as createScheduled, SCHEDULED_RUNTIME_KEY } from '~/scheduled/scheduled.ts';
import type * as EngineAdapterTypes from '~/_adapters/types.ts';
import type * as EngineAccessModule from '~/_engine/access.ts';
import type * as EngineCompileTypes from '~/_engine/compile/types.ts';
import type * as EngineRuntimeTypes from '~/_engine/runtime/types.ts';
import type * as PublicApi from '~/context.ts';
import type * as LifecycleTypes from '~/lifecycle/lifecycle.ts';
import type * as DefineModule from '~/modules/define.ts';
import type * as PrimitiveCore from '~/primitive.ts';
import type * as ScheduledPrimitiveTypes from '~/scheduled/types.ts';
import type * as DefineServer from '~/server-definition.ts';

type ConnectionDescriptor = EngineAdapterTypes.ConnectionDescriptor;
type ConnectionHandle = EngineAdapterTypes.ConnectionHandle;
type UpgradeDecision = EngineAdapterTypes.UpgradeDecision;
type AnyScheduled = EngineCompileTypes.AnyScheduled;
type CompiledChannel = EngineCompileTypes.CompiledChannel;
type CompiledNamespace = EngineCompileTypes.CompiledNamespace;
type RuntimeConnection = EngineRuntimeTypes.RuntimeConnection;
type ModuleRuntime = EngineRuntimeTypes.ModuleRuntime;
type ResolvedScope = EngineRuntimeTypes.ResolvedScope;
type RoutingTarget = EngineRuntimeTypes.RoutingTarget;
type BroadcastOptions = PublicApi.BroadcastOptions;
type Primitive = PrimitiveCore.Primitive;

export type {
  AdapterConfig,
  ConnectionDescriptor,
  ConnectionHandle,
  EngineOptions,
  UpgradeDecision,
} from '~/_adapters/types.ts';

/**
 * Create the empty hook registries the engine fills during primitive setup.
 */
function createRegisteredHooks(): EngineRuntimeTypes.RegisteredEngineHooks {
  return {
    activity: [],
    incoming: [],
    outgoing: [],
    beforeSend: [],
    afterSend: [],
    protocol: new Map(),
    contextExtenders: [],
    boot: [],
    init: [],
    connect: [],
    disconnect: [],
    shutdown: [],
    error: [],
    upgrade: [],
    builderUpgrade: undefined,
    binary: [],
    validationError: [],
    alarm: [],
    beforeSubscribe: new Map(),
    subscribe: new Map(),
    unsubscribe: new Map(),
    sessionEnd: new Map(),
  };
}

/**
 * Stateful runtime executor for one compiled server definition.
 *
 * Adapters provide storage, timers, and websocket handles. The engine handles
 * the framework behavior: lifecycle hooks, validation, replay, streams,
 * modules, channel membership, and scheduled work.
 */
export class Engine {
  private readonly options: EngineAdapterTypes.EngineOptions;
  private readonly primitives: readonly PrimitiveCore.Primitive[];
  private readonly compiled: EngineCompileTypes.CompiledServer;
  /** @internal */
  readonly hooks = createRegisteredHooks();
  private storage?: PublicApi.StorageProvider;
  /** @internal */
  env: Record<string, unknown> = {};
  /** @internal */
  timers?: PublicApi.TimerProvider;
  /** @internal */
  platform: unknown = {};
  /** @internal */
  waitUntilImpl: (promise: Promise<unknown>) => void = () => {};
  private hasWaitUntil = false;
  private hibernationEnabled = false;
  /**
   * Stable id of this engine instance in a multi-instance cluster. `undefined`
   * by default — every ConnectionRef built locally carries `undefined`, the
   * subscribe path treats those as local, and the broker is not consulted.
   * Adapters that run alongside a broker call `setInstanceId(...)` from their
   * setup so refs start carrying real instance ids.
   * @internal
   */
  private engineInstanceId: string | undefined;
  private replayEnabled = false;
  private sequencePersistent = false;
  /**
   * Whether the `withPersistence` wrapper called `.enablePersistence()`. When
   * true, the engine creates the identity-keyed durable tables at boot and
   * starts writing channel memberships across reconnects.
   * @internal
   */
  private persistenceEnabled = false;
  /**
   * Per-channel-key overrides recorded by the `.persistent(value)` marker.
   * Absent entries inherit the server default (always persistent when
   * `persistenceEnabled` is true). Explicit `false` opts a channel out.
   * @internal
   */
  private readonly channelPersistenceOverrides = new Map<string, boolean>();
  /**
   * Declared tag groups, indexed by kind. Populated by `tagGroups()` primitive
   * setup. The maps stay empty when `withTags` is not wrapped — every
   * `ctx.tags.<kind>(group)` call validates against these sets.
   * @internal
   */
  private readonly declaredTagGroups = {
    ephemeral: new Set<string>(),
    persistent: new Set<string>(),
  };
  private tagGroupsRegistered = { ephemeral: false, persistent: false };
  /** @internal */
  incomingDedupCap = 0;
  private readonly declaredErrorCodes = new Set<string>([
    ValidationFailed.code,
    ChannelNotFound.code,
    ChannelNotSubscribed.code,
    InvalidScopeMarkers.code,
    NamespaceNotFound.code,
    StreamAborted.code,
    StreamAlreadyActive.code,
  ]);
  /** Logger used by the engine and runtime modules. Adapters supply a custom logger via {@link Engine.setLogger}; otherwise the engine falls back to a console-backed default. */
  private logger: PublicApi.Logger = {
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

  /** @internal */
  readonly connections = new Map<string, RuntimeConnection>();
  /** @internal */
  readonly wsToConnectionId = new Map<unknown, string>();
  /** @internal */
  readonly activeStreams = new Map<string, EngineRuntimeTypes.ActiveStream>();
  private readonly scheduledRuns = new Map<string, ScheduledPrimitiveTypes.ScheduledRun>();
  private readonly scheduledDlq = new Map<string, ScheduledPrimitiveTypes.ScheduledDeadLetter>();
  private readonly installedFeatures = new Set<symbol>();
  private alarmHandle: unknown = null;
  private idCounter = 0;
  private readonly instanceNonce = Math.random().toString(36).slice(2, 8);
  /** @internal */
  readonly moduleRuntimes: EngineRuntimeTypes.ModuleRuntime[] = [];
  /** @internal */
  activeConnectionId?: string;
  private initialized = false;

  // ─────── Section: connection state / identity ───────

  /**
   * Compile the declarative server definition once up front.
   */
  constructor(handler: DefineServer.ServerDefinition, options: EngineAdapterTypes.EngineOptions) {
    this.options = options;
    this.primitives = handler.primitives;
    this.compiled = EngineCompile.compileHandlerDefinition(handler);
  }

  // ─────── Section: storage/env/platform setters ───────

  /**
   * Provide the storage driver the adapter wants the engine to use.
   */
  setStorage(storage: PublicApi.StorageProvider): void {
    this.storage = storage;
  }

  /**
   * Provide adapter-owned environment bindings to every runtime context.
   */
  setEnv(env: Record<string, unknown>): void {
    this.env = env;
  }

  /**
   * Provide the timer/alarm implementation used for heartbeat and scheduling.
   */
  setTimerProvider(timers: PublicApi.TimerProvider): void {
    this.timers = timers;
  }

  /**
   * Provide an adapter-specific platform object to runtime contexts.
   */
  setPlatform(platform: unknown): void {
    this.platform = platform;
  }

  /**
   * Provide the adapter's `waitUntil` equivalent so tasks can outlive a single
   * request or websocket callback.
   */
  setWaitUntil(waitUntil: (promise: Promise<unknown>) => void): void {
    this.hasWaitUntil = true;
    this.waitUntilImpl = waitUntil;
  }

  /**
   * Provide the structured logger the engine and runtime modules should write to.
   *
   * Call once during adapter setup. If never called, the engine falls back to
   * a `console.*`-backed default.
   */
  setLogger(logger: PublicApi.Logger): void {
    this.logger = logger;
  }

  /**
   * Read the active logger.
   *
   * @internal
   */
  getLogger(): PublicApi.Logger {
    return this.logger;
  }

  /**
   * Read the compiled handler definition built at construction time.
   *
   * @internal
   */
  getCompiled(): EngineCompileTypes.CompiledServer {
    return this.compiled;
  }

  /**
   * Read storage or fail with an adapter-specific setup error.
   * @internal
   */
  requireStorage(): PublicApi.StorageProvider {
    if (!this.storage) {
      throw new Error(`[wskit] storage not provided by adapter "${this.options.adapterId}".`);
    }
    return this.storage;
  }

  /**
   * Read timers or fail with an adapter-specific setup error.
   * @internal
   */
  requireTimers(): PublicApi.TimerProvider {
    if (!this.timers) {
      throw new Error(`[wskit] timers not provided by adapter "${this.options.adapterId}".`);
    }
    return this.timers;
  }

  /**
   * Ensure the adapter actually provides every capability the compiled handler
   * declared that it needs.
   */
  private validateRequires(): void {
    const requires = this.compiled.requires;
    if (requires.storage && !this.storage) {
      throw new Error(
        `[wskit] Handler requires storage, but adapter "${this.options.adapterId}" did not provide it.`,
      );
    }
    if (requires.timers && !this.timers) {
      throw new Error(
        `[wskit] Handler requires timers, but adapter "${this.options.adapterId}" did not provide it.`,
      );
    }
    if (requires.hibernation && !this.options.hibernation) {
      throw new Error(
        `[wskit] Handler requires hibernation, but adapter "${this.options.adapterId}" does not support it.`,
      );
    }
  }

  /**
   * Ensure the adapter provides internal engine guarantees needed by the
   * runtime hooks that primitives registered during setup.
   */
  private validateEngineRequirements(): void {
    if (!this.hasWaitUntil) {
      throw new Error(`[wskit] Adapter "${this.options.adapterId}" did not provide waitUntil.`);
    }

    if (this.replayEnabled && !this.sequencePersistent) {
      throw new Error('[wskit] replay() requires sequence({ persist: true }) for durable replay.');
    }
  }

  /**
   * Build the hook-registration object passed into one module's setup phase.
   *
   * Modules do not get direct engine access. They get this smaller surface,
   * which lets them register lifecycle and message hooks in a controlled way.
   */
  // ─────── Section: hook registration ───────

  private createModuleHooks(
    runtime: EngineRuntimeTypes.ModuleRuntime,
  ): DefineModule.ModuleHooks<any> {
    return {
      onIncoming: (handler) => {
        runtime.onIncoming = handler;
      },
      onOutgoing: (handler) => {
        runtime.onOutgoing = handler;
      },
      onInit: (handler) => {
        runtime.onInit = handler;
      },
      onConnect: (handler) => {
        runtime.onConnect = handler;
      },
      onDisconnect: (handler) => {
        runtime.onDisconnect = handler;
      },
      onShutdown: (handler) => {
        runtime.onShutdown = handler;
      },
      scheduled: (name: string, callback) => {
        const taskId = `__${runtime.instance.id}:${name}`;
        this.compiled.scheduled.set(taskId, createScheduled(taskId, callback) as AnyScheduled);
        this.ensureScheduledRuntime();
        return { id: taskId };
      },
      generateId: (prefix?: string) => this.generateId(prefix),
      getState: () => {
        const connection = this.activeConnectionId
          ? this.connections.get(this.activeConnectionId)
          : undefined;

        return connection
          ? this.toConnectionInfo(connection)
          : {
              id: '',
              identity: '',
              meta: {},
              tags: [],
              channels: [],
              latency: null,
              quality: 'good',
              bufferedAmount: 0,
              ref: () => EngineContexts.buildConnectionRef('', '', this.engineInstanceId),
            };
      },
    };
  }

  /**
   * Append one hook to a channel-scoped registry.
   *
   * Channel lifecycle hooks only make sense inside `channel(...)`, so this
   * helper enforces that rule before the hook is stored.
   */
  private pushChannelHook<T>(
    hooks: Map<string, T[]>,
    channelKey: string | undefined,
    hook: T,
    hookName: 'onBeforeSubscribe' | 'onSubscribe' | 'onUnsubscribe' | 'onSessionEnd',
  ): void {
    if (!channelKey) {
      throw new Error(`[wskit] ${hookName}() can only be registered inside channel(...).`);
    }

    const existing = hooks.get(channelKey) ?? [];
    existing.push(hook);
    hooks.set(channelKey, existing);
  }

  /**
   * Create the runtime registration API passed to built-in primitives.
   *
   * This is the boundary between the generic engine and primitive-owned
   * behavior. Primitives can register hooks and use shared services, but they
   * do not receive the full `Engine` instance directly.
   */
  private createEngineAccess(scope?: { channelKey?: string }): EngineAccessModule.EngineAccess {
    // Per-primitive guard. Each primitive's __setup receives a fresh
    // EngineAccess object, so this flag is local to one primitive's
    // registration scope. A primitive that calls onUpgrade twice from
    // the same __setup throws — that's a programming error in the
    // primitive. Two different primitives each calling onUpgrade once
    // remains fine; their hooks compose through the upgrade-phase
    // merge (internal hooks first, builder hook last).
    let onUpgradeCalled = false;
    return {
      installOnce: (key, install) => {
        if (this.installedFeatures.has(key)) return;
        this.installedFeatures.add(key);
        install();
      },
      onBoot: (handler) => {
        this.hooks.boot.push(handler);
      },
      onIncoming: (handler) => {
        this.hooks.incoming.push(handler);
      },
      onOutgoing: (handler) => {
        this.hooks.outgoing.push(handler);
      },
      onBeforeSend: (handler) => {
        this.hooks.beforeSend.push(handler);
      },
      onAfterSend: (handler) => {
        this.hooks.afterSend.push(handler);
      },
      onConnectionActivity: (handler) => {
        this.hooks.activity.push(handler);
      },
      onInit: (handler) => {
        this.hooks.init.push(handler);
      },
      onConnect: (handler) => {
        this.hooks.connect.push(handler);
      },
      onDisconnect: (handler) => {
        this.hooks.disconnect.push(handler);
      },
      onShutdown: (handler) => {
        this.hooks.shutdown.push(handler);
      },
      onError: (handler) => {
        this.hooks.error.push(handler);
      },
      onUpgrade: (handler) => {
        if (onUpgradeCalled) {
          throw new Error(
            '[wskit] A primitive may only register one onUpgrade hook in its __setup. Compose multiple upgrade-time concerns inside one handler.',
          );
        }
        onUpgradeCalled = true;
        this.hooks.upgrade.push(handler);
      },
      setBuilderUpgradeHook: (handler) => {
        if (this.hooks.builderUpgrade !== undefined) {
          throw new Error(
            '[wskit] The builder onUpgrade hook is already set. Compose multiple upgrade-time concerns inside one .onUpgrade(...) handler.',
          );
        }
        this.hooks.builderUpgrade = handler;
      },
      onBinary: (handler) => {
        this.hooks.binary.push(handler);
      },
      onValidationError: (handler) => {
        this.hooks.validationError.push(handler);
      },
      onProtocolMessage: (event, handler) => {
        const existing = this.hooks.protocol.get(event) ?? [];
        existing.push(handler);
        this.hooks.protocol.set(event, existing);
      },
      onAlarm: (handler) => {
        this.hooks.alarm.push(handler);
      },
      onBeforeSubscribe: (handler, validator) => {
        this.pushChannelHook(
          this.hooks.beforeSubscribe,
          scope?.channelKey,
          { handler, validator },
          'onBeforeSubscribe',
        );
      },
      onSubscribe: (handler) => {
        this.pushChannelHook(this.hooks.subscribe, scope?.channelKey, handler, 'onSubscribe');
      },
      onUnsubscribe: (handler) => {
        this.pushChannelHook(this.hooks.unsubscribe, scope?.channelKey, handler, 'onUnsubscribe');
      },
      onSessionEnd: (handler) => {
        this.pushChannelHook(this.hooks.sessionEnd, scope?.channelKey, handler, 'onSessionEnd');
      },
      getScopeInfo: () => ({
        channelKey: scope?.channelKey,
      }),
      getReplayClaimedChannelKeys: () => this.compiled.replayClaimedChannelKeys,
      extendContext: (factory) => {
        this.hooks.contextExtenders.push(factory);
      },
      requireStorage: () => this.requireStorage(),
      requireTimers: () => this.requireTimers(),
      setHibernationEnabled: (enabled) => {
        this.hibernationEnabled = enabled;
      },
      setReplayEnabled: (enabled) => {
        this.replayEnabled = enabled;
      },
      setSequencePersistent: (enabled) => {
        this.sequencePersistent = enabled;
      },
      setPersistenceEnabled: (enabled) => {
        this.persistenceEnabled = enabled;
      },
      setChannelPersistent: (channelKey, enabled) => {
        this.channelPersistenceOverrides.set(channelKey, enabled);
      },
      registerTagGroups: (kind, groups) => {
        if (this.tagGroupsRegistered[kind]) {
          throw new Error(
            `[wskit] .tagGroups('${kind}', ...) declared more than once on this builder.`,
          );
        }
        this.tagGroupsRegistered[kind] = true;
        if (kind === 'persistent' && !this.persistenceEnabled) {
          const sample = groups[0];
          throw new Error(
            `[wskit] persistent tag group '${sample}' requires withPersistence and a call to .enablePersistence(). Wrap your server with withPersistence(...) and call .enablePersistence() on the builder, or move '${sample}' to the 'ephemeral' kind.`,
          );
        }
        for (const group of groups) this.declaredTagGroups[kind].add(group);
      },
      isDurableMembershipPairPersistent: (channelName, channelScope) =>
        this.isDurableMembershipPairPersistent(channelName, channelScope),
      getLogger: () => this.logger,
      enableIncomingDedup: (cap) => {
        if (!Number.isFinite(cap) || cap <= 0) return;
        this.incomingDedupCap = Math.max(this.incomingDedupCap, Math.floor(cap));
      },
      registerErrorDefinitions: (defs) => {
        for (const def of defs) {
          this.declaredErrorCodes.add(def.code);
        }
      },
      refreshConnectionIdleTimeout: (connectionId, timeoutMs) => {
        const connection = this.connections.get(connectionId);
        if (!connection) return;

        HeartbeatPrimitive.refreshHeartbeatTimeout(this.requireTimers(), connection, timeoutMs);
      },
      getScheduledRuns: () => this.scheduledRuns,
      getScheduledDlq: () => this.scheduledDlq,
      getScheduledTask: (taskId) => this.compiled.scheduled.get(taskId),
      getScheduledTasks: () => this.compiled.scheduled.values(),
      createTaskContext: () => this.createTaskContext(),
      sendReplay: (connectionId, channelName, channelScope, event, payload, wire) => {
        const connection = this.connections.get(connectionId);
        if (!connection) return;
        this.sendReplay(connection, channelName, channelScope, event, payload, wire);
      },
      assertReplaySendContract: (event, payload, routing) => {
        OutgoingRuntime.assertPayloadRecord(payload);
        OutgoingRuntime.assertNoReservedPayloadFields(payload);
        if (!OutgoingRuntime.isDeclaredOutgoingEvent(this.compiled, event, routing)) {
          throw new Error(
            `[wskit] Outgoing event "${event}" was not declared in the active scope.`,
          );
        }
      },
      sendAck: (connectionId) => {
        const connection = this.connections.get(connectionId);
        if (!connection?.activeAckId) return;
        this.sendProtocolMessage(connection, '_ack', { _ackId: connection.activeAckId });
      },
      rescheduleAlarm: () => this.rescheduleAlarm(),
      generateId: (prefix) => this.generateId(prefix),
      waitUntil: (promise) => {
        this.waitUntilImpl(promise);
      },
      rawSend: (connectionId, event, payload) => {
        const connection = this.connections.get(connectionId);
        if (!connection) return;
        this.sendProtocolMessage(connection, event, payload as Record<string, unknown>);
      },
    };
  }

  /**
   * Walk the primitive tree and let built-in primitives register runtime hooks.
   *
   * Scope information is threaded through the walk so channel-specific
   * lifecycle hooks know which channel family they belong to.
   */
  private installPrimitiveHooks(): void {
    const visit = (primitives: readonly Primitive[], scope?: { channelKey?: string }) => {
      for (const primitive of primitives) {
        primitive.__setup?.(this.createEngineAccess(scope));

        if (primitive.__wskit === 'namespace') {
          visit((primitive as Primitive & { primitives: readonly Primitive[] }).primitives, scope);
          continue;
        }

        if (primitive.__wskit === 'channel') {
          const channelPrimitive = primitive as Primitive & {
            pattern: string | { key: string };
            primitives: readonly Primitive[];
          };
          visit(channelPrimitive.primitives, {
            channelKey:
              typeof channelPrimitive.pattern === 'string'
                ? channelPrimitive.pattern
                : channelPrimitive.pattern.key,
          });
        }
      }
    };

    visit(this.primitives);
  }

  /**
   * Finish one-time startup work: validate adapter capabilities, install
   * modules, run primitive boot hooks, and then run the init hook.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.validateRequires();
    this.installPrimitiveHooks();
    if (this.compiled.scheduled.size > 0) {
      this.ensureScheduledRuntime();
    }
    this.validateEngineRequirements();

    for (const moduleInstance of this.compiled.modules) {
      const runtime: ModuleRuntime = {
        instance: moduleInstance,
        contextFactory: () => ({}),
      };
      runtime.contextFactory = moduleInstance.setupModule(
        moduleInstance.args,
        this.createModuleHooks(runtime),
      );
      this.moduleRuntimes.push(runtime);
    }

    for (const hook of this.hooks.boot) {
      await hook();
    }

    const initCtx = this.createInitContext();
    for (const hook of this.hooks.init) {
      await hook(initCtx);
    }
    for (const runtime of this.moduleRuntimes) {
      if (runtime.onInit) {
        await runtime.onInit(
          this.createModuleScopedContext(
            runtime.instance.id,
            initCtx as unknown as Record<PropertyKey, unknown>,
          ),
        );
      }
    }
    this.initialized = true;
  }

  // ─────── Section: context builders ───────

  /**
   * Build the context object used by init hooks.
   */
  private createInitContext() {
    return EngineContexts.createInitContext({
      env: this.env,
      logger: this.logger,
      platform: this.platform,
      requireStorage: () => this.requireStorage(),
    });
  }

  /**
   * Build the context object used while the engine is shutting down.
   */
  private createShutdownContext() {
    return EngineContexts.createShutdownContext({
      connections: this.connections,
      ...EngineDeps.commonDeps(this),
    });
  }

  /**
   * Build the context object passed into scheduled task handlers.
   */
  private createTaskContext() {
    return EngineContexts.createTaskContext({
      connections: this.connections,
      ...EngineDeps.commonDeps(this),
    });
  }

  /**
   * Build the live handler context for one connection.
   *
   * When a handler runs inside a namespace or channel, the matching scoped APIs
   * are attached to the returned context.
   */
  /** @internal */
  buildConnectionContext(
    connection: RuntimeConnection,
    scope?: { namespace?: CompiledNamespace; channel?: CompiledChannel },
  ) {
    return EngineContexts.buildConnectionContext(
      {
        compiled: this.compiled,
        connections: this.connections,
        ...EngineDeps.commonDeps(this),
      },
      connection,
      scope,
    );
  }

  /**
   * Wrap one context so module event helpers automatically target that
   * module's private event namespace.
   */
  private createModuleScopedContext(moduleId: string, ctx: Record<PropertyKey, unknown>) {
    return EngineContexts.createModuleScopedContext(moduleId, ctx);
  }

  /**
   * Attach every installed module API object to one context.
   * @internal
   */
  attachModuleApis(ctx: Record<PropertyKey, unknown>, connection?: RuntimeConnection): void {
    EngineContexts.attachModuleApis(this.moduleRuntimes, ctx, connection);
  }

  /**
   * Send an internal protocol message without any outgoing validation or
   * decoration.
   *
   * Wraps `JSON.stringify` so a non-serializable payload field (BigInt,
   * circular reference, function, symbol) cannot crash the dispatcher.
   * On serialization failure, log and send a sanitized `_error` frame
   * carrying just the routing markers so the client's request/stream
   * correlation still resolves.
   * @internal
   */
  sendProtocolMessage(
    connection: RuntimeConnection,
    event: string,
    payload: Record<string, unknown>,
  ): void {
    let wire: string;
    try {
      wire = JSON.stringify({ event, payload });
    } catch (error) {
      this.logger.error('[wskit] Failed to serialize protocol frame; sending fallback _error', {
        event,
        error: error instanceof Error ? error.message : String(error),
      });
      const fallbackPayload: Record<string, unknown> = { code: InternalError.code };
      for (const key of PROTOCOL_PAYLOAD_FIELDS) {
        if (key in payload) fallbackPayload[key] = payload[key];
      }
      try {
        wire = JSON.stringify({ event: '_error', payload: fallbackPayload });
      } catch (fallbackError) {
        this.logger.error('[wskit] Fallback _error frame also failed to serialize; dropping', {
          error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
        });
        return;
      }
    }
    connection.descriptor.send(wire);
  }

  /**
   * Send a replay entry with its stored wire metadata restored.
   * @internal
   */
  sendReplay(
    connection: RuntimeConnection,
    channelName: string | null,
    channelScope: string | null,
    event: string,
    payload: unknown,
    wire: { seq: number; messageId: string; channel?: string },
  ): void {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('[wskit] Outgoing payload must be a plain object.');
    }

    const finalPayload: Record<string, unknown> = {
      ...(payload as Record<string, unknown>),
      _seq: wire.seq,
      _messageId: wire.messageId,
    };

    const resolvedChannel = channelName ?? wire.channel ?? null;
    if (resolvedChannel !== null) finalPayload._channel = resolvedChannel;
    if (channelScope !== null) finalPayload._channelScope = channelScope;

    // Mirror the sendProtocolMessage hardening: a non-serializable user
    // payload (BigInt, circular reference, function, symbol) must not
    // crash the replay loop. On failure, log and emit a sanitized
    // `_error` frame carrying just the routing markers so the client can
    // correlate the row, then return so the caller's loop keeps
    // iterating remaining rows.
    let frame: string;
    try {
      frame = JSON.stringify({ event, payload: finalPayload });
    } catch (error) {
      this.logger.error('[wskit] Failed to serialize replay frame; sending fallback _error', {
        event,
        error: error instanceof Error ? error.message : String(error),
      });
      const fallbackPayload: Record<string, unknown> = { code: InternalError.code };
      for (const key of PROTOCOL_PAYLOAD_FIELDS) {
        if (key in finalPayload) fallbackPayload[key] = finalPayload[key];
      }
      try {
        frame = JSON.stringify({ event: '_error', payload: fallbackPayload });
      } catch (fallbackError) {
        this.logger.error('[wskit] Fallback _error frame also failed to serialize; dropping', {
          error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
        });
        return;
      }
    }
    connection.descriptor.send(frame);
  }

  /**
   * Convert live connection state into the public info shape used by hooks and
   * module helpers.
   * @internal
   */
  toConnectionInfo(connection: RuntimeConnection) {
    return EngineContexts.toConnectionInfo(connection, this.engineInstanceId);
  }

  /**
   * Read the instance id this engine is running as. `undefined` in
   * single-instance setups.
   * @internal
   */
  get instanceId(): string | undefined {
    return this.engineInstanceId;
  }

  /**
   * Set the instance id the adapter computed for this engine. Used by the
   * future broker integration to route cross-instance calls. Single-instance
   * adapters never call this.
   */
  setInstanceId(id: string): void {
    this.engineInstanceId = id;
  }

  /**
   * Write the current connection state to engine storage and, if the adapter
   * supports hibernation, also write a tiny attachment carrying the id so the
   * wake path can look the row up. Skipped while the connection is inside
   * the accept window — `onConnect` mutations buffer and flush once at the
   * end so a handler that joins ten channels writes one row, not ten.
   * @internal
   */
  persistAttachment(connection: RuntimeConnection): void {
    if (connection.pendingWrites?.active) return;
    if (!this.hibernationEnabled) return;
    ConnectionStore.writeConnectionRow(
      this.requireStorage().sql,
      ConnectionStore.buildConnectionRow(connection),
    );
    this.options.hibernation?.persist(connection.wsKey, { id: connection.id });
  }

  /**
   * Read one persisted connection row by id, or `null` when it no longer
   * exists. Used by the hibernation wake path to rebuild in-memory state.
   * @internal
   */
  readConnectionState(connectionId: string): ConnectionStore.StoredConnectionRow | null {
    if (!this.hibernationEnabled) return null;
    return ConnectionStore.readConnectionRow(this.requireStorage().sql, connectionId);
  }

  /**
   * Delete the persisted row for one connection. Called from the disconnect
   * path after disconnect hooks run.
   * @internal
   */
  deleteConnectionState(connectionId: string): void {
    if (!this.hibernationEnabled) return;
    ConnectionStore.deleteConnectionRow(this.requireStorage().sql, connectionId);
  }

  /**
   * Boot-time cleanup. Delete every persisted connection row whose id is not
   * in the surviving set. Adapters call this after engine init with the ids
   * of sockets the platform still holds (zero ids = wipe everything).
   * @internal
   */
  reconcileConnections(surviving: ReadonlySet<string>): void {
    if (!this.hibernationEnabled) return;
    ConnectionStore.reconcileConnectionRows(this.requireStorage().sql, surviving);
  }

  /**
   * Generate a simple monotonically increasing id for engine-owned runtime
   * objects such as connections, messages, streams, and scheduled runs.
   * @internal
   */
  generateId(prefix = 'id'): string {
    this.idCounter += 1;
    return `${prefix}_${this.instanceNonce}_${this.idCounter}`;
  }

  // ─────── Section: adapter entry points ───────

  /**
   * Accept a newly upgraded websocket and return the callbacks the adapter uses
   * to drive it.
   */
  accept(wsKey: unknown, descriptor: ConnectionDescriptor): ConnectionHandle {
    return EngineConnectionRuntime.acceptConnection(
      EngineDeps.connectionRuntime(this),
      wsKey,
      descriptor,
    );
  }

  /**
   * Tell adapters whether this handler actually opted into connection
   * hibernation on a platform that supports it.
   */
  usesHibernation(): boolean {
    return this.hibernationEnabled;
  }

  /**
   * Whether the handler called `.enablePersistence()`. When `true`, the engine
   * creates the identity-keyed durable tables at boot and starts writing
   * channel memberships across reconnects.
   *
   * @internal
   */
  usesPersistence(): boolean {
    return this.persistenceEnabled;
  }

  /**
   * Whether a specific channel should write durable memberships. Returns
   * `false` when persistence is disabled at the server level OR the channel
   * called `.persistent(false)`. Returns `true` when persistence is on at the
   * server level and the channel didn't opt out.
   *
   * @internal
   */
  isChannelPersistent(channelKey: string): boolean {
    if (!this.persistenceEnabled) return false;
    return this.channelPersistenceOverrides.get(channelKey) !== false;
  }

  /**
   * Whether at least one tag group was registered via `tagGroups()`. Adapters
   * and the context builder use this to decide whether to expose `ctx.tags`.
   * @internal
   */
  usesTags(): boolean {
    return this.tagGroupsRegistered.ephemeral || this.tagGroupsRegistered.persistent;
  }

  /**
   * Whether the group is declared under the given kind. Thrown errors from
   * the tag surface use this to point devs at `.tagGroups(...)` when they
   * try to access an undeclared group.
   * @internal
   */
  isTagGroupDeclared(kind: 'ephemeral' | 'persistent', group: string): boolean {
    return this.declaredTagGroups[kind].has(group);
  }

  /**
   * Read the declared groups of one kind. Order is insertion order. Used by
   * tag fan-out paths and the boot-time cleanup helper.
   * @internal
   */
  getDeclaredTagGroups(kind: 'ephemeral' | 'persistent'): ReadonlySet<string> {
    return this.declaredTagGroups[kind];
  }

  /**
   * Check whether a `(channelName, channelScope)` pair from a durable row
   * still maps to a registered persistent channel in this engine. Used by
   * boot-time reconcile to spot orphaned rows from removed or
   * `.persistent(false)`-flipped channels.
   * @internal
   */
  isDurableMembershipPairPersistent(channelName: string, channelScope: string | null): boolean {
    if (!this.persistenceEnabled) return false;
    // Static channel: scope is null and the channel is registered by name.
    if (channelScope === null) {
      const channel = this.compiled.channels.get(channelName);
      return channel ? this.isChannelPersistent(channel.key) : false;
    }
    // Dynamic family: scope is the family key.
    const family = this.compiled.channelFamilies.get(channelScope);
    return family ? this.isChannelPersistent(family.key) : false;
  }

  /**
   * Write a durable channel-membership row for the given identity. The caller
   * is responsible for first checking `isChannelPersistent(...)` — the engine
   * still gates on `persistenceEnabled` defensively so a stale caller can't
   * write rows on a persistence-disabled server.
   *
   * @internal
   */
  persistMembership(identity: string, channelName: string, channelScope: string | null): void {
    if (!this.persistenceEnabled) return;
    const storage = this.requireStorage();
    PersistenceStorage.insertMembership(storage.sql, identity, channelName, channelScope);
  }

  /**
   * Delete a durable channel-membership row. Called on a true leave (client
   * `_unsubscribe`, `removeMember`, kick) of a persistent channel.
   *
   * @internal
   */
  deleteDurableMembership(
    identity: string,
    channelName: string,
    channelScope: string | null,
  ): void {
    if (!this.persistenceEnabled) return;
    const storage = this.requireStorage();
    PersistenceStorage.deleteMembership(storage.sql, identity, channelName, channelScope);
  }

  /**
   * Remove every live connection of `identity` from one channel scope AND
   * drop the durable membership row. True-leave semantics: `onUnsubscribe`
   * fires, `_memberLeave`/`_memberOffline` broadcast to remaining peers,
   * the durable row is gone so the user will NOT be auto-rejoined on next
   * reconnect.
   *
   * No-op when no live connection matches and persistence is disabled.
   * @internal
   */
  async removeChannelMember(
    channelName: string,
    channelScope: string | null,
    identity: string,
  ): Promise<void> {
    if (this.persistenceEnabled) {
      const storage = this.requireStorage();
      PersistenceStorage.deleteMembership(storage.sql, identity, channelName, channelScope);
    }

    const membershipKey = ChannelPrimitive.createChannelMembershipKey(channelName, channelScope);
    const resolved = ChannelPrimitive.resolveCompiledChannel(
      this.compiled,
      channelName,
      channelScope,
    );

    const targets: RuntimeConnection[] = [];
    for (const connection of this.connections.values()) {
      if (connection.identity !== identity) continue;
      if (!connection.channelMemberships.has(membershipKey)) continue;
      targets.push(connection);
    }

    for (const connection of targets) {
      try {
        await this.leaveChannel(connection, {
          channel: resolved,
          channelName,
          channelScope,
        });
      } catch (error) {
        this.logger.error('[wskit] removeChannelMember leaveChannel threw', {
          identity,
          channel: channelName,
          channelScope,
          connectionId: connection.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Drop every persistent membership and persistent tag for the given
   * identity, then close every live socket of that identity. The wskit
   * equivalent of "this user is gone, wipe them everywhere". Backs the
   * future `admin().purgeIdentity()` surface.
   * @internal
   */
  async purgeIdentity(identity: string): Promise<void> {
    // Collect `(channelName, channelScope)` pairs from both live sockets
    // and durable rows before any removal, so the walk below has a stable
    // list. Keys are JSON-encoded tuples so any character a dev might put
    // in a channel name survives the pack/unpack round-trip.
    const channelKeys = new Set<string>();

    for (const connection of this.connections.values()) {
      if (connection.identity !== identity) continue;
      for (const membership of connection.channelMemberships.values()) {
        channelKeys.add(JSON.stringify([membership.channelName, membership.channelScope]));
      }
    }

    if (this.persistenceEnabled) {
      const storage = this.requireStorage();
      const rows = PersistenceStorage.listMembershipsByIdentity(storage.sql, identity);
      for (const row of rows) {
        channelKeys.add(JSON.stringify([row.channelName, row.channelScope]));
      }
    }

    for (const key of channelKeys) {
      const [channelName, channelScope] = JSON.parse(key) as [string, string | null];
      await this.removeChannelMember(channelName, channelScope, identity);
    }

    if (this.persistenceEnabled) {
      const storage = this.requireStorage();
      PersistenceStorage.purgeMembershipsByIdentity(storage.sql, identity);
      PersistenceStorage.purgeTagsByIdentity(storage.sql, identity);
    }
  }

  /**
   * Restore every durable channel membership the identity had before. Called
   * from `acceptConnection` between the initial connection-row write and
   * `onConnect`. No-op when persistence is disabled or the identity has no
   * stored rows.
   *
   * @internal
   */
  async autoRejoinIdentity(connection: RuntimeConnection): Promise<void> {
    if (!this.persistenceEnabled) return;
    const storage = this.requireStorage();
    await runAutoRejoin(
      {
        sql: storage.sql,
        subscribeConnectionAsServer: async (
          target,
          channelName,
          channelScope,
          payload,
          rejoining,
        ) => {
          const ref: PublicApi.ConnectionRef = {
            __wskit: 'connection-ref',
            id: target.id,
            instance: this.engineInstanceId,
            identity: target.identity,
          };
          return EngineMessageRuntime.subscribeFromServer(
            { ...EngineDeps.channelRuntime(this), instanceId: this.engineInstanceId },
            ref,
            channelName,
            channelScope,
            payload,
            rejoining,
          );
        },
        sendProtocolMessage: (target, event, payload) =>
          this.sendProtocolMessage(target, event, payload),
        logger: this.logger,
      },
      connection,
    );
  }

  /**
   * Read the adapter's hibernation API.
   *
   * Adapters that support hibernation provide `persist` + `restore`. The
   * engine routes connection-state snapshots through these methods instead
   * of reaching into platform-specific WebSocket APIs directly.
   *
   * @internal
   */
  getHibernationApi(): EngineAdapterTypes.HibernationApi | undefined {
    return this.options.hibernation;
  }

  /**
   * Rebuild a connection handle for a websocket the adapter woke from
   * hibernation.
   */
  handleHibernationWake(wsKey: unknown): ConnectionHandle {
    if (!this.usesHibernation()) {
      throw new Error('[wskit] hibernation() is not enabled for this handler.');
    }

    return EngineConnectionRuntime.wakeHibernatedConnection(
      EngineDeps.connectionRuntime(this),
      wsKey,
    );
  }

  /**
   * Run the optional upgrade hook before the adapter commits to the websocket
   * handshake.
   */
  async handleUpgrade(request: Request): Promise<UpgradeDecision> {
    return EngineConnectionRuntime.handleUpgrade(
      {
        upgradeHooks: this.hooks.upgrade,
        builderUpgradeHook: this.hooks.builderUpgrade,
        upgradeHelpers: this.buildUpgradeHelpers(),
      },
      request,
    );
  }

  /**
   * Build the helper bag passed as the second argument to every `onUpgrade`
   * hook. `withTags` populates `tags`. Other wrappers can add more fields
   * here by extending the helper interface.
   *
   * @internal
   */
  private buildUpgradeHelpers(): LifecycleTypes.UpgradeHelpers {
    if (!this.usesTags()) return {};
    const isDeclared = (kind: 'ephemeral' | 'persistent', group: string) =>
      this.declaredTagGroups[kind].has(group);
    function buildRefFactory(kind: 'ephemeral' | 'persistent') {
      return (group: string) => {
        if (!isDeclared(kind, group)) {
          throw new Error(
            `[wskit] tag group '${group}' is not declared under .tagGroups('${kind}', ...). Register it on the builder or check for a typo.`,
          );
        }
        return {
          ref: (key: string): PublicApi.TagRef => ({
            __wskit: 'tag-ref',
            kind,
            group,
            key,
          }),
        };
      };
    }
    return {
      tags: {
        ephemeral: buildRefFactory('ephemeral'),
        persistent: buildRefFactory('persistent'),
      },
    };
  }

  /**
   * Shut down the engine and all connection/module activity owned by it.
   */
  async handleShutdown(): Promise<void> {
    const engine = this;
    return EngineConnectionRuntime.handleShutdown({
      connections: this.connections,
      timers: this.timers,
      shutdownHooks: this.hooks.shutdown,
      moduleRuntimes: this.moduleRuntimes,
      createShutdownContext: () => this.createShutdownContext(),
      cancelActiveStreamsForConnection: (connectionId) => {
        return this.cancelActiveStreamsForConnection(connectionId);
      },
      handleConnectionClose: (connection) =>
        this.handleConnectionClose(connection, CloseCodes.GOING_AWAY, 'Server shutting down'),
      alarmState: {
        get current() {
          return engine.alarmHandle;
        },
        set current(value: unknown | null) {
          engine.alarmHandle = value;
        },
      },
      logger: this.logger,
    });
  }

  /**
   * Run primitive-owned alarm hooks after an alarm or timer wake-up.
   *
   * The scheduled primitive currently uses this to process queued task runs.
   */
  async handleAlarm(): Promise<void> {
    await this.initialize();
    for (const hook of this.hooks.alarm) {
      await hook();
    }
  }

  // ─────── Section: scheduled-runtime management ───────

  private ensureScheduledRuntime(): void {
    if (this.installedFeatures.has(SCHEDULED_RUNTIME_KEY)) return;
    this.installedFeatures.add(SCHEDULED_RUNTIME_KEY);

    const runtime = {
      requireStorage: () => this.requireStorage(),
      requireTimers: () => this.requireTimers(),
      generateId: (prefix?: string) => this.generateId(prefix),
      getScheduledRuns: () => this.scheduledRuns,
      getScheduledDlq: () => this.scheduledDlq,
      getScheduledTask: (taskId: string) => this.compiled.scheduled.get(taskId),
      getScheduledTasks: () => this.compiled.scheduled.values(),
      createTaskContext: () => this.createTaskContext(),
      rescheduleAlarm: () => this.rescheduleAlarm(),
    };

    this.hooks.boot.push(() => {
      ScheduledPrimitive.bootstrapScheduledRuntime(runtime);
    });
    this.hooks.alarm.push(async () => {
      await ScheduledPrimitive.handleScheduledAlarm(runtime);
    });
  }

  /**
   * Queue one future scheduled task run.
   *
   * The queueing rules themselves live in the scheduled primitive helpers; the
   * engine is only providing shared state and services here.
   * @internal
   */
  scheduleTask(taskId: string, time: number, data: unknown): void {
    ScheduledPrimitive.scheduleTaskRun(
      {
        requireStorage: () => this.requireStorage(),
        requireTimers: () => this.requireTimers(),
        generateId: (prefix) => this.generateId(prefix),
        getScheduledRuns: () => this.scheduledRuns,
        getScheduledDlq: () => this.scheduledDlq,
        getScheduledTask: (scheduledTaskId) => this.compiled.scheduled.get(scheduledTaskId),
        getScheduledTasks: () => this.compiled.scheduled.values(),
        createTaskContext: () => this.createTaskContext(),
        rescheduleAlarm: () => this.rescheduleAlarm(),
      },
      taskId,
      time,
      data,
    );
  }

  /**
   * Remove every queued run for one scheduled task id.
   * @internal
   */
  cancelScheduled(
    taskId: string,
    filter?: Record<string, unknown>,
  ): ScheduledPrimitiveTypes.ScheduledCancelResult {
    return ScheduledPrimitive.cancelScheduledRuns(
      {
        requireStorage: () => this.requireStorage(),
        requireTimers: () => this.requireTimers(),
        generateId: (prefix) => this.generateId(prefix),
        getScheduledRuns: () => this.scheduledRuns,
        getScheduledDlq: () => this.scheduledDlq,
        getScheduledTask: (scheduledTaskId) => this.compiled.scheduled.get(scheduledTaskId),
        getScheduledTasks: () => this.compiled.scheduled.values(),
        createTaskContext: () => this.createTaskContext(),
        rescheduleAlarm: () => this.rescheduleAlarm(),
      },
      taskId,
      filter,
    );
  }

  /**
   * Ask the adapter timer API to wake the engine when the next queued task
   * becomes due.
   */
  private rescheduleAlarm(): void {
    ScheduledPrimitive.rescheduleScheduledAlarm({
      requireTimers: () => this.requireTimers(),
      getScheduledRuns: () => this.scheduledRuns,
      getAlarmHandle: () => this.alarmHandle,
      setAlarmHandle: (handle) => {
        this.alarmHandle = handle;
      },
      onAlarm: () => this.handleAlarm(),
    });
  }

  // ─────── Section: connection lifecycle ───────

  /**
   * Run connect/disconnect lifecycle hooks for both the handler and installed
   * modules.
   * @internal
   */
  async runConnectionLifecycle(
    kind: 'connect' | 'disconnect',
    ctx: Record<PropertyKey, unknown>,
  ): Promise<void> {
    const engine = this;
    return EngineConnectionRuntime.runConnectionLifecycle(
      {
        moduleRuntimes: this.moduleRuntimes,
        activeConnectionState: {
          get current() {
            return engine.activeConnectionId;
          },
          set current(value: string | undefined) {
            engine.activeConnectionId = value;
          },
        },
        connectHooks: this.hooks.connect,
        disconnectHooks: this.hooks.disconnect,
        createModuleScopedContext: (moduleId, targetCtx) => {
          return this.createModuleScopedContext(moduleId, targetCtx);
        },
      },
      kind,
      ctx,
    );
  }

  /**
   * Fully close a connection: cancel streams, run disconnect hooks, leave
   * channels, and forget runtime state.
   * @internal
   */
  async handleConnectionClose(
    connection: RuntimeConnection,
    code: number,
    reason: string,
  ): Promise<void> {
    return EngineConnectionRuntime.handleConnectionClose(
      {
        compiled: this.compiled,
        connections: this.connections,
        wsToConnectionId: this.wsToConnectionId,
        timers: this.timers,
        cancelActiveStreamsForConnection: (connectionId) => {
          return this.cancelActiveStreamsForConnection(connectionId);
        },
        buildConnectionContext: (targetConnection, scope) => {
          return this.buildConnectionContext(targetConnection, scope);
        },
        runConnectionLifecycle: (kind, ctx) => this.runConnectionLifecycle(kind, ctx),
        leaveChannel: (targetConnection, scope, kickedReason, disconnect) =>
          this.leaveChannel(targetConnection, scope, kickedReason, disconnect),
        logger: this.logger,
      },
      connection,
      code,
      reason,
    );
  }

  /**
   * Stop every active stream owned by a connection.
   */
  private async cancelActiveStreamsForConnection(connectionId: string): Promise<void> {
    return EngineConnectionRuntime.cancelActiveStreamsForConnection(
      {
        activeStreams: this.activeStreams,
      },
      connectionId,
    );
  }

  /**
   * Route a binary frame into the optional binary lifecycle hook.
   * @internal
   */
  async handleBinaryMessage(connection: RuntimeConnection, data: ArrayBuffer): Promise<void> {
    return EngineConnectionRuntime.handleBinaryMessage(
      {
        buildConnectionContext: (targetConnection, scope) => {
          return this.buildConnectionContext(targetConnection, scope);
        },
        handleRuntimeError: (targetConnection, error, event) => {
          return this.handleRuntimeError(targetConnection, error, event);
        },
        activityHooks: this.hooks.activity,
        binaryHooks: this.hooks.binary,
      },
      connection,
      data,
    );
  }

  /**
   * Parse and route one websocket text frame.
   * @internal
   */
  async processTextMessage(connection: RuntimeConnection, data: string): Promise<void> {
    return EngineMessageRuntime.processTextMessage(
      EngineDeps.dispatchRuntime(this),
      connection,
      data,
    );
  }

  // ─────── Section: message dispatch wiring ───────

  /**
   * Validate and send one outgoing event through the runtime pipeline.
   * @internal
   */
  sendThroughPipeline(
    connection: RuntimeConnection,
    routing: RoutingTarget | undefined,
    event: string,
    payload: unknown,
  ): boolean {
    return EngineMessageRuntime.sendThroughPipeline(
      EngineDeps.outgoingRuntime(this),
      connection,
      routing,
      event,
      payload,
    );
  }

  /**
   * Broadcast a top-level or namespace event to a selected connection set.
   * @internal
   */
  broadcastToConnections(
    connections: readonly RuntimeConnection[],
    event: string,
    payload: unknown,
    options?: BroadcastOptions & { namespace?: string },
    excludeConnectionId?: string,
  ): void {
    EngineMessageRuntime.broadcastToConnections(
      EngineDeps.outgoingRuntime(this),
      connections,
      event,
      payload,
      options,
      excludeConnectionId,
    );
  }

  /**
   * Broadcast an event to every current member of a channel.
   * @internal
   */
  broadcastToChannel(
    channelName: string,
    event: string,
    payload: unknown,
    excludeConnectionId: string | undefined,
    channelScope: string | null,
    excludeSelf?: boolean,
  ): void {
    EngineMessageRuntime.broadcastToChannel(
      EngineDeps.memberRuntime(this),
      channelName,
      event,
      payload,
      excludeConnectionId,
      channelScope,
      excludeSelf,
    );
  }

  /**
   * Return a public snapshot of the current members in a channel.
   * @internal
   */
  getChannelMembers(channelName: string, channelScope: string | null) {
    return EngineMessageRuntime.getChannelMembers(
      EngineDeps.memberRuntime(this),
      channelName,
      channelScope,
    );
  }

  /**
   * Remove tagged members from a channel, typically for moderation.
   * @internal
   */
  kickChannelMembers(
    channelName: string,
    target: ChannelPrimitive.KickTarget,
    reason: string,
    channelScope: string | null,
  ): Promise<void> {
    return EngineMessageRuntime.kickChannelMembers(
      {
        ...EngineDeps.channelRuntime(this),
        leaveChannel: (targetConnection, scope, kickedReason) => {
          return this.leaveChannel(targetConnection, scope, kickedReason);
        },
      },
      channelName,
      target,
      reason,
      channelScope,
    );
  }

  /**
   * Leave a channel, run unsubscribe hooks, and notify remaining members.
   */
  private async leaveChannel(
    connection: RuntimeConnection,
    scope: { channel?: CompiledChannel; channelName: string; channelScope: string | null },
    kickedReason?: string,
    disconnect?: boolean,
  ): Promise<void> {
    return EngineMessageRuntime.leaveChannel(
      EngineDeps.channelRuntime(this),
      connection,
      scope,
      kickedReason,
      disconnect,
    );
  }

  /**
   * Handle the `_subscribe` protocol message for a channel.
   * @internal
   */
  async handleSubscribe(
    connection: RuntimeConnection,
    payload: Record<string, unknown> | undefined,
  ): Promise<void> {
    return EngineMessageRuntime.handleSubscribe(
      EngineDeps.channelRuntime(this),
      connection,
      payload,
    );
  }

  /**
   * Server-initiated subscribe. Backs `channelHandle.subscribe(ref, payload?)`.
   * @internal
   */
  async subscribeConnectionAsServer(
    ref: PublicApi.ConnectionRef,
    channelName: string,
    channelScope: string | null,
    payload: unknown,
  ): Promise<void> {
    return EngineMessageRuntime.subscribeFromServer(
      { ...EngineDeps.channelRuntime(this), instanceId: this.engineInstanceId },
      ref,
      channelName,
      channelScope,
      payload,
    );
  }

  /**
   * Handle the `_unsubscribe` protocol message for a channel.
   * @internal
   */
  async handleUnsubscribe(
    connection: RuntimeConnection,
    payload: Record<string, unknown> | undefined,
  ): Promise<void> {
    return EngineMessageRuntime.handleUnsubscribe(
      {
        ...EngineDeps.channelRuntime(this),
        leaveChannel: (targetConnection, scope) => this.leaveChannel(targetConnection, scope),
      },
      connection,
      payload,
    );
  }

  /**
   * Normalize an error and send the engine `_error` protocol message.
   * @internal
   */
  async handleRuntimeError(
    connection: RuntimeConnection,
    error: unknown,
    event?: string,
    routing?: Record<string, unknown>,
  ): Promise<void> {
    return ErrorsPrimitive.sendRuntimeError(
      {
        buildConnectionContext: (targetConnection, scope) => {
          return this.buildConnectionContext(targetConnection, scope);
        },
        resolveScopeFromRouting: (errorRouting) => this.resolveScopeFromRouting(errorRouting),
        declaredErrorCodes: this.declaredErrorCodes,
        errorHooks: this.hooks.error,
        logger: this.logger,
        sendProtocolMessage: (targetConnection, outgoingEvent, payload) => {
          this.sendProtocolMessage(targetConnection, outgoingEvent, payload);
        },
      },
      connection,
      error,
      event,
      routing,
    );
  }

  /**
   * Resolve a `ResolvedScope` from the wire routing markers carried alongside
   * a runtime error. Used by `onError` hook context construction so the hook
   * sees `ctx.namespace` / `ctx.channel` matching the throwing handler.
   *
   * Returns undefined for routing that does not name a known namespace or
   * channel — top-level fallback keeps hooks observable even when the routing
   * is malformed.
   * @internal
   */
  private resolveScopeFromRouting(
    routing: Record<string, unknown>,
  ): EngineRuntimeTypes.ResolvedScope | undefined {
    if (typeof routing._namespace === 'string') {
      const namespace = this.compiled.namespaces.get(routing._namespace);
      if (namespace) return { namespace };
    }
    if (typeof routing._channel === 'string') {
      if (typeof routing._channelScope === 'string') {
        const family = this.compiled.channelFamilies.get(routing._channelScope);
        if (family && ChannelPrimitive.matchesScopePattern(family.pattern, routing._channel)) {
          return {
            channel: family,
            channelName: routing._channel,
            channelScope: routing._channelScope,
          };
        }
      } else {
        const channel = this.compiled.channels.get(routing._channel);
        if (channel) {
          return { channel, channelName: routing._channel, channelScope: null };
        }
      }
    }
    return undefined;
  }

  /**
   * Run validation-error hooks before normal error handling continues.
   * @internal
   */
  async handleValidationError(
    connection: RuntimeConnection,
    event: string,
    validationError: unknown,
    scope?: ResolvedScope,
  ): Promise<void> {
    return ErrorsPrimitive.notifyValidationError(
      {
        buildConnectionContext: (targetConnection, targetScope) => {
          return this.buildConnectionContext(targetConnection, targetScope);
        },
        validationErrorHooks: this.hooks.validationError,
      },
      connection,
      event,
      validationError,
      scope,
    );
  }
}
