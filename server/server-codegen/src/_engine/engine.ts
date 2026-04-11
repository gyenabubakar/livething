/* oxlint-disable @typescript-eslint/no-explicit-any */
import * as EngineCompile from '~/_engine/compile/compile.ts';
import * as EngineContexts from '~/_engine/contexts/contexts.ts';
import * as EngineConnectionRuntime from '~/_engine/runtime/connection.ts';
import * as EngineMessageRuntime from '~/_engine/runtime/messages.ts';
import * as ErrorsPrimitive from '~/errors/runtime.ts';
import * as HeartbeatPrimitive from '~/heartbeat/runtime.ts';
import * as ScheduledPrimitive from '~/scheduled/runtime.ts';
import type * as EngineAccessModule from '~/_engine/access.ts';
import type * as EngineAdapterTypes from '~/_engine/adapter/types.ts';
import type * as EngineCompileTypes from '~/_engine/compile/types.ts';
import type * as EngineRuntimeTypes from '~/_engine/runtime/types.ts';
import type * as DefineModule from '~/define-module.ts';
import type * as DefineServer from '~/define-server.ts';
import type * as PublicApi from '~/index.ts';
import type * as PrimitiveCore from '~/primitive.ts';
import type * as ScheduledPrimitiveTypes from '~/scheduled/types.ts';

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
} from '~/_engine/adapter/types.ts';

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
    binary: [],
    validationError: [],
    alarm: [],
    beforeSubscribe: new Map(),
    subscribe: new Map(),
    unsubscribe: new Map(),
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
  private readonly hooks = createRegisteredHooks();
  private storage?: PublicApi.StorageProvider;
  private env: Record<string, unknown> = {};
  private timers?: PublicApi.TimerProvider;
  private platform: unknown = {};
  private waitUntilImpl: (promise: Promise<unknown>) => void = () => {};
  private hasWaitUntil = false;
  private hibernationEnabled = false;
  private replayEnabled = false;
  private sequencePersistent = false;
  private readonly declaredErrorCodes = new Set<string>();
  /** Default logger used when the adapter does not provide a custom one. */
  private readonly logger = {
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

  private readonly connections = new Map<string, RuntimeConnection>();
  private readonly wsToConnectionId = new Map<unknown, string>();
  private readonly activeStreams = new Map<string, EngineRuntimeTypes.ActiveStream>();
  private readonly scheduledRuns = new Map<string, ScheduledPrimitiveTypes.ScheduledRun>();
  private readonly scheduledDlq = new Map<string, ScheduledPrimitiveTypes.ScheduledDeadLetter>();
  private readonly installedFeatures = new Set<symbol>();
  private alarmHandle: unknown | null = null;
  private idCounter = 0;
  private readonly moduleRuntimes: EngineRuntimeTypes.ModuleRuntime[] = [];
  private activeConnectionId?: string;
  private initialized = false;

  /**
   * Compile the declarative server definition once up front.
   */
  constructor(handler: DefineServer.ServerDefinition, options: EngineAdapterTypes.EngineOptions) {
    this.options = options;
    this.primitives = handler.primitives;
    this.compiled = EngineCompile.compileHandlerDefinition(handler);
  }

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
   * Read storage or fail with an adapter-specific setup error.
   */
  private requireStorage(): PublicApi.StorageProvider {
    if (!this.storage) {
      throw new Error(`[wskit] storage not provided by adapter "${this.options.adapterId}".`);
    }
    return this.storage;
  }

  /**
   * Read timers or fail with an adapter-specific setup error.
   */
  private requireTimers(): PublicApi.TimerProvider {
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
      scheduled: (
        name: string,
        handler: (ctx: any, data: any) => void | Promise<void>,
        options,
      ) => {
        const taskId = `__${runtime.instance.id}:${name}`;
        this.compiled.scheduled.set(taskId, {
          ...runtime.instance,
          __wskit: 'scheduled',
          taskId,
          handler,
          options,
        } as unknown as AnyScheduled);
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
              meta: {},
              tags: [],
              channels: [],
              latency: null,
              quality: 'good',
              bufferedAmount: 0,
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
    hookName: 'onBeforeSubscribe' | 'onSubscribe' | 'onUnsubscribe',
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
        this.hooks.upgrade.push(handler);
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
      getScopeInfo: () => ({
        channelKey: scope?.channelKey,
      }),
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

        if (primitive.__wskit === 'passive' || primitive.__wskit === 'namespace') {
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
      env: this.env,
      logger: this.logger,
      platform: this.platform,
      waitUntilImpl: this.waitUntilImpl,
      requireStorage: () => this.requireStorage(),
      requireTimers: () => this.requireTimers(),
      scheduleTask: (taskId, time, data) => this.scheduleTask(taskId, time, data),
      cancelScheduled: (taskId, filter) => this.cancelScheduled(taskId, filter),
      broadcastToConnections: (connections, event, payload, options, excludeConnectionId) => {
        this.broadcastToConnections(connections, event, payload, options, excludeConnectionId);
      },
      sendThroughPipeline: (connection, routing, event, payload) => {
        return this.sendThroughPipeline(connection, routing, event, payload);
      },
      broadcastToChannel: (channelName, event, payload, excludeConnectionId, channelScope) => {
        this.broadcastToChannel(channelName, event, payload, excludeConnectionId, channelScope);
      },
      getChannelMembers: (channelName) => this.getChannelMembers(channelName),
      kickChannelMembers: (channelName, tag, reason) => {
        this.kickChannelMembers(channelName, tag, reason);
      },
      sendReplay: (connection, channelName, channelScope, event, payload, wire) => {
        this.sendReplay(connection, channelName, channelScope, event, payload, wire);
      },
      sendProtocolMessage: (connection, event, payload) => {
        this.sendProtocolMessage(connection, event, payload);
      },
      persistAttachment: (connection) => this.persistAttachment(connection),
      toConnectionInfo: (connection) => this.toConnectionInfo(connection),
      attachModuleApis: (ctx, connection) => this.attachModuleApis(ctx, connection),
      contextExtenders: this.hooks.contextExtenders,
    });
  }

  /**
   * Build the context object passed into scheduled task handlers.
   */
  private createTaskContext() {
    return EngineContexts.createTaskContext({
      connections: this.connections,
      env: this.env,
      logger: this.logger,
      platform: this.platform,
      waitUntilImpl: this.waitUntilImpl,
      requireStorage: () => this.requireStorage(),
      requireTimers: () => this.requireTimers(),
      scheduleTask: (taskId, time, data) => this.scheduleTask(taskId, time, data),
      cancelScheduled: (taskId, filter) => this.cancelScheduled(taskId, filter),
      broadcastToConnections: (connections, event, payload, options, excludeConnectionId) => {
        this.broadcastToConnections(connections, event, payload, options, excludeConnectionId);
      },
      sendThroughPipeline: (connection, routing, event, payload) => {
        return this.sendThroughPipeline(connection, routing, event, payload);
      },
      broadcastToChannel: (channelName, event, payload, excludeConnectionId, channelScope) => {
        this.broadcastToChannel(channelName, event, payload, excludeConnectionId, channelScope);
      },
      getChannelMembers: (channelName) => this.getChannelMembers(channelName),
      kickChannelMembers: (channelName, tag, reason) => {
        this.kickChannelMembers(channelName, tag, reason);
      },
      sendReplay: (connection, channelName, channelScope, event, payload, wire) => {
        this.sendReplay(connection, channelName, channelScope, event, payload, wire);
      },
      sendProtocolMessage: (connection, event, payload) => {
        this.sendProtocolMessage(connection, event, payload);
      },
      persistAttachment: (connection) => this.persistAttachment(connection),
      toConnectionInfo: (connection) => this.toConnectionInfo(connection),
      attachModuleApis: (ctx, connection) => this.attachModuleApis(ctx, connection),
      contextExtenders: this.hooks.contextExtenders,
    });
  }

  /**
   * Build the live handler context for one connection.
   *
   * When a handler runs inside a namespace or channel, the matching scoped APIs
   * are attached to the returned context.
   */
  private buildConnectionContext(
    connection: RuntimeConnection,
    scope?: { namespace?: CompiledNamespace; channel?: CompiledChannel },
  ) {
    return EngineContexts.buildConnectionContext(
      {
        compiled: this.compiled,
        connections: this.connections,
        env: this.env,
        logger: this.logger,
        platform: this.platform,
        waitUntilImpl: this.waitUntilImpl,
        requireStorage: () => this.requireStorage(),
        requireTimers: () => this.requireTimers(),
        scheduleTask: (taskId, time, data) => this.scheduleTask(taskId, time, data),
        cancelScheduled: (taskId, filter) => this.cancelScheduled(taskId, filter),
        broadcastToConnections: (connections, event, payload, options, excludeConnectionId) => {
          this.broadcastToConnections(connections, event, payload, options, excludeConnectionId);
        },
        sendThroughPipeline: (connectionArg, routing, event, payload) => {
          return this.sendThroughPipeline(connectionArg, routing, event, payload);
        },
        broadcastToChannel: (channelName, event, payload, excludeConnectionId, channelScope) => {
          this.broadcastToChannel(channelName, event, payload, excludeConnectionId, channelScope);
        },
        getChannelMembers: (channelName) => this.getChannelMembers(channelName),
        kickChannelMembers: (channelName, tag, reason) => {
          this.kickChannelMembers(channelName, tag, reason);
        },
        sendReplay: (connectionArg, channelName, channelScope, event, payload, wire) => {
          this.sendReplay(connectionArg, channelName, channelScope, event, payload, wire);
        },
        sendProtocolMessage: (connectionArg, event, payload) => {
          this.sendProtocolMessage(connectionArg, event, payload);
        },
        persistAttachment: (connectionArg) => this.persistAttachment(connectionArg),
        toConnectionInfo: (connectionArg) => this.toConnectionInfo(connectionArg),
        attachModuleApis: (ctx, connectionArg) => this.attachModuleApis(ctx, connectionArg),
        contextExtenders: this.hooks.contextExtenders,
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
   */
  private attachModuleApis(
    ctx: Record<PropertyKey, unknown>,
    connection?: RuntimeConnection,
  ): void {
    EngineContexts.attachModuleApis(this.moduleRuntimes, ctx, connection);
  }

  /**
   * Send an internal protocol message without any outgoing validation or
   * decoration.
   */
  private sendProtocolMessage(
    connection: RuntimeConnection,
    event: string,
    payload: Record<string, unknown>,
  ): void {
    connection.descriptor.send(JSON.stringify({ event, payload }));
  }

  /**
   * Send a replay entry with its stored wire metadata restored.
   */
  private sendReplay(
    connection: RuntimeConnection,
    channelName: string | undefined,
    channelScope: string | undefined,
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

    if (channelName ?? wire.channel) finalPayload._channel = channelName ?? wire.channel;
    if (channelScope) finalPayload._channelScope = channelScope;

    connection.descriptor.send(JSON.stringify({ event, payload: finalPayload }));
  }

  /**
   * Convert live connection state into the public info shape used by hooks and
   * module helpers.
   */
  private toConnectionInfo(connection: RuntimeConnection) {
    return EngineContexts.toConnectionInfo(connection);
  }

  /**
   * Ask the adapter to serialize connection attachment data when supported.
   */
  private persistAttachment(connection: RuntimeConnection): void {
    EngineContexts.persistAttachment(connection);
  }

  /**
   * Generate a simple monotonically increasing id for engine-owned runtime
   * objects such as connections, messages, streams, and scheduled runs.
   */
  private generateId(prefix = 'id'): string {
    this.idCounter += 1;
    return `${prefix}_${this.idCounter}`;
  }

  /**
   * Build the dependency bag used by helpers that only care about outgoing
   * message processing.
   */
  private outgoingRuntime() {
    return {
      compiled: this.compiled,
      moduleRuntimes: this.moduleRuntimes,
      outgoingHooks: this.hooks.outgoing,
      beforeSendHooks: this.hooks.beforeSend,
      afterSendHooks: this.hooks.afterSend,
      waitUntil: (promise: Promise<unknown>) => this.waitUntilImpl(promise),
      logger: this.logger,
      generateId: (prefix?: string) => this.generateId(prefix),
      activityHooks: this.hooks.activity,
    };
  }

  /**
   * Build the dependency bag used by helpers that also need live connection and
   * channel membership data.
   */
  private memberRuntime() {
    return {
      ...this.outgoingRuntime(),
      connections: this.connections,
      toConnectionInfo: (connection: RuntimeConnection) => this.toConnectionInfo(connection),
      sendThroughPipeline: (
        connection: RuntimeConnection,
        routing: RoutingTarget | undefined,
        event: string,
        payload: unknown,
      ) => this.sendThroughPipeline(connection, routing, event, payload),
    };
  }

  /**
   * Build the dependency bag used by channel subscribe and unsubscribe helpers.
   */
  private channelRuntime() {
    return {
      ...this.memberRuntime(),
      beforeSubscribeHooks: this.hooks.beforeSubscribe,
      subscribeHooks: this.hooks.subscribe,
      unsubscribeHooks: this.hooks.unsubscribe,
      broadcastToChannel: (
        channelName: string,
        event: string,
        payload: unknown,
        excludeConnectionId?: string,
        channelScope?: string,
      ) => {
        EngineMessageRuntime.broadcastToChannel(
          this.dispatchRuntime(),
          channelName,
          event,
          payload,
          excludeConnectionId,
          channelScope,
        );
      },
      buildConnectionContext: (connection: RuntimeConnection, scope?: ResolvedScope) => {
        return this.buildConnectionContext(connection, scope);
      },
      persistAttachment: (connection: RuntimeConnection) => this.persistAttachment(connection),
      sendProtocolMessage: (
        connection: RuntimeConnection,
        event: string,
        payload: Record<string, unknown>,
      ) => this.sendProtocolMessage(connection, event, payload),
      handleValidationError: (
        connection: RuntimeConnection,
        event: string,
        validationError: unknown,
        scope?: ResolvedScope,
      ) => this.handleValidationError(connection, event, validationError, scope),
    };
  }

  /**
   * Build the dependency bag used by inbound text-message dispatch.
   */
  private dispatchRuntime() {
    return {
      ...this.memberRuntime(),
      logger: this.logger,
      activeStreams: this.activeStreams,
      protocolHandlers: this.hooks.protocol,
      incomingHooks: this.hooks.incoming,
      errorHooks: this.hooks.error,
      requireTimers: () => this.requireTimers(),
      buildConnectionContext: (connection: RuntimeConnection, scope?: ResolvedScope) => {
        return this.buildConnectionContext(connection, scope);
      },
      sendProtocolMessage: (
        connection: RuntimeConnection,
        event: string,
        payload: Record<string, unknown>,
      ) => this.sendProtocolMessage(connection, event, payload),
      sendReplay: (
        connection: RuntimeConnection,
        channelName: string | undefined,
        channelScope: string | undefined,
        event: string,
        payload: unknown,
        wire: { seq: number; messageId: string; channel?: string },
      ) => this.sendReplay(connection, channelName, channelScope, event, payload, wire),
      persistAttachment: (connection: RuntimeConnection) => this.persistAttachment(connection),
      setActiveConnectionId: (value?: string) => {
        this.activeConnectionId = value;
      },
      handleRuntimeError: (
        connection: RuntimeConnection,
        error: unknown,
        event?: string,
        routing?: Record<string, unknown>,
      ) => this.handleRuntimeError(connection, error, event, routing),
      handleValidationError: (
        connection: RuntimeConnection,
        event: string,
        validationError: unknown,
        scope?: ResolvedScope,
      ) => this.handleValidationError(connection, event, validationError, scope),
      handleSubscribe: (
        connection: RuntimeConnection,
        payload: Record<string, unknown> | undefined,
      ) => this.handleSubscribe(connection, payload),
      handleUnsubscribe: (
        connection: RuntimeConnection,
        payload: Record<string, unknown> | undefined,
      ) => this.handleUnsubscribe(connection, payload),
    };
  }

  /**
   * Build the dependency bag used by connection accept, wake, and close logic.
   */
  private connectionRuntime() {
    return {
      compiled: this.compiled,
      timers: this.timers,
      connections: this.connections,
      wsToConnectionId: this.wsToConnectionId,
      generateId: (prefix?: string) => this.generateId(prefix),
      persistAttachment: (connection: RuntimeConnection) => this.persistAttachment(connection),
      buildConnectionContext: (connection: RuntimeConnection, scope?: ResolvedScope) => {
        return this.buildConnectionContext(connection, scope);
      },
      runConnectionLifecycle: (
        kind: 'connect' | 'disconnect',
        ctx: Record<PropertyKey, unknown>,
      ) => {
        return this.runConnectionLifecycle(kind, ctx);
      },
      processTextMessage: (connection: RuntimeConnection, data: string) => {
        return this.processTextMessage(connection, data);
      },
      handleBinaryMessage: (connection: RuntimeConnection, data: ArrayBuffer) => {
        return this.handleBinaryMessage(connection, data);
      },
      handleConnectionClose: (connection: RuntimeConnection, code: number, reason: string) => {
        return this.handleConnectionClose(connection, code, reason);
      },
      handleRuntimeError: (connection: RuntimeConnection, error: unknown, event?: string) => {
        return this.handleRuntimeError(connection, error, event);
      },
    };
  }

  /**
   * Accept a newly upgraded websocket and return the callbacks the adapter uses
   * to drive it.
   */
  accept(wsKey: unknown, descriptor: ConnectionDescriptor): ConnectionHandle {
    return EngineConnectionRuntime.acceptConnection(this.connectionRuntime(), wsKey, descriptor);
  }

  /**
   * Tell adapters whether this handler actually opted into connection
   * hibernation on a platform that supports it.
   */
  usesHibernation(): boolean {
    return this.options.hibernation && this.hibernationEnabled;
  }

  /**
   * Rebuild a connection handle for a websocket the adapter woke from
   * hibernation.
   */
  handleHibernationWake(wsKey: unknown): ConnectionHandle {
    if (!this.usesHibernation()) {
      throw new Error('[wskit] hibernation() is not enabled for this handler.');
    }

    return EngineConnectionRuntime.wakeHibernatedConnection(this.connectionRuntime(), wsKey);
  }

  /**
   * Run the optional upgrade hook before the adapter commits to the websocket
   * handshake.
   */
  async handleUpgrade(request: Request): Promise<UpgradeDecision> {
    return EngineConnectionRuntime.handleUpgrade(
      {
        upgradeHooks: this.hooks.upgrade,
      },
      request,
    );
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
      alarmState: {
        get current() {
          return engine.alarmHandle;
        },
        set current(value: unknown | null) {
          engine.alarmHandle = value;
        },
      },
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

  /**
   * Queue one future scheduled task run.
   *
   * The queueing rules themselves live in the scheduled primitive helpers; the
   * engine is only providing shared state and services here.
   */
  private scheduleTask(taskId: string, time: number, data: unknown): void {
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
   */
  private cancelScheduled(taskId: string, filter?: Record<string, unknown>): void {
    ScheduledPrimitive.cancelScheduledRuns(
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

  /**
   * Run connect/disconnect lifecycle hooks for both the handler and installed
   * modules.
   */
  private async runConnectionLifecycle(
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
   */
  private async handleConnectionClose(
    connection: RuntimeConnection,
    _code: number,
    _reason: string,
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
        leaveChannel: (targetConnection, scope) => this.leaveChannel(targetConnection, scope),
      },
      connection,
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
   */
  private async handleBinaryMessage(
    connection: RuntimeConnection,
    data: ArrayBuffer,
  ): Promise<void> {
    return EngineConnectionRuntime.handleBinaryMessage(
      {
        buildConnectionContext: (targetConnection, scope) => {
          return this.buildConnectionContext(targetConnection, scope);
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
   */
  private async processTextMessage(connection: RuntimeConnection, data: string): Promise<void> {
    return EngineMessageRuntime.processTextMessage(this.dispatchRuntime(), connection, data);
  }

  /**
   * Validate and send one outgoing event through the runtime pipeline.
   */
  private sendThroughPipeline(
    connection: RuntimeConnection,
    routing: RoutingTarget | undefined,
    event: string,
    payload: unknown,
  ): boolean {
    return EngineMessageRuntime.sendThroughPipeline(
      this.outgoingRuntime(),
      connection,
      routing,
      event,
      payload,
    );
  }

  /**
   * Broadcast a top-level or namespace event to a selected connection set.
   */
  private broadcastToConnections(
    connections: readonly RuntimeConnection[],
    event: string,
    payload: unknown,
    options?: BroadcastOptions & { namespace?: string },
    excludeConnectionId?: string,
  ): void {
    EngineMessageRuntime.broadcastToConnections(
      this.outgoingRuntime(),
      connections,
      event,
      payload,
      options,
      excludeConnectionId,
    );
  }

  /**
   * Broadcast an event to every current member of a channel.
   */
  private broadcastToChannel(
    channelName: string,
    event: string,
    payload: unknown,
    excludeConnectionId?: string,
    channelScope?: string,
  ): void {
    EngineMessageRuntime.broadcastToChannel(
      this.memberRuntime(),
      channelName,
      event,
      payload,
      excludeConnectionId,
      channelScope,
    );
  }

  /**
   * Return a public snapshot of the current members in a channel.
   */
  private getChannelMembers(channelName: string) {
    return EngineMessageRuntime.getChannelMembers(this.memberRuntime(), channelName);
  }

  /**
   * Remove tagged members from a channel, typically for moderation.
   */
  private kickChannelMembers(channelName: string, tag: string, reason: string): void {
    EngineMessageRuntime.kickChannelMembers(
      {
        ...this.channelRuntime(),
        leaveChannel: (targetConnection, scope, kickedReason) => {
          return this.leaveChannel(targetConnection, scope, kickedReason);
        },
      },
      channelName,
      tag,
      reason,
    );
  }

  /**
   * Leave a channel, run unsubscribe hooks, and notify remaining members.
   */
  private async leaveChannel(
    connection: RuntimeConnection,
    scope: { channel?: CompiledChannel; channelName: string; channelScope?: string },
    kickedReason?: string,
  ): Promise<void> {
    return EngineMessageRuntime.leaveChannel(
      this.channelRuntime(),
      connection,
      scope,
      kickedReason,
    );
  }

  /**
   * Handle the `_subscribe` protocol message for a channel.
   */
  private async handleSubscribe(
    connection: RuntimeConnection,
    payload: Record<string, unknown> | undefined,
  ): Promise<void> {
    return EngineMessageRuntime.handleSubscribe(this.channelRuntime(), connection, payload);
  }

  /**
   * Handle the `_unsubscribe` protocol message for a channel.
   */
  private async handleUnsubscribe(
    connection: RuntimeConnection,
    payload: Record<string, unknown> | undefined,
  ): Promise<void> {
    return EngineMessageRuntime.handleUnsubscribe(
      {
        ...this.channelRuntime(),
        leaveChannel: (targetConnection, scope) => this.leaveChannel(targetConnection, scope),
      },
      connection,
      payload,
    );
  }

  /**
   * Normalize an error and send the engine `_error` protocol message.
   */
  private async handleRuntimeError(
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
   * Run validation-error hooks before normal error handling continues.
   */
  private async handleValidationError(
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
