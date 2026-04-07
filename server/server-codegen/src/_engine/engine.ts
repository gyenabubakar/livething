/* oxlint-disable @typescript-eslint/no-explicit-any */
import { compileHandlerDefinition } from './compile/compile.ts';
import {
  attachModuleApis,
  buildConnectionContext,
  createInitContext,
  createModuleScopedContext,
  createShutdownContext,
  createTaskContext,
  persistAttachment,
  toConnectionInfo,
} from './contexts/contexts.ts';
import {
  acceptConnection,
  cancelActiveStreamsForConnection,
  handleBinaryMessage,
  handleConnectionClose,
  handleShutdown,
  handleUpgrade,
  refreshHeartbeat,
  runConnectionLifecycle,
  wakeHibernatedConnection,
} from './runtime/connection.ts';
import {
  broadcastToChannel,
  broadcastToConnections,
  getChannelMembers,
  handleReplay,
  handleRuntimeError,
  handleSubscribe,
  handleUnsubscribe,
  kickChannelMembers,
  leaveChannel,
  processTextMessage,
  resolveScope,
  sendThroughPipeline,
} from './runtime/messages.ts';
import {
  cancelScheduled,
  handleAlarm,
  persistScheduledRuns,
  rescheduleAlarm,
  restoreScheduledRuns,
  scheduleTask,
} from './runtime/scheduling.ts';
import type { ModuleHooks } from '../define-module.ts';
import type { ServerDefinition } from '../define-server.ts';
import type { BroadcastOptions, StorageProvider, TimerProvider } from '../index.ts';
import type {
  ConnectionDescriptor,
  ConnectionHandle,
  EngineOptions,
  UpgradeDecision,
} from './adapter/types.ts';
import type {
  AnyScheduled,
  CompiledChannel,
  CompiledNamespace,
  CompiledServer,
} from './compile/types.ts';
import type {
  ActiveStream,
  ModuleRuntime,
  ResolvedScope,
  RoutingTarget,
  RuntimeConnection,
  ScheduledRun,
} from './runtime/types.ts';

export type {
  AdapterConfig,
  ConnectionDescriptor,
  ConnectionHandle,
  EngineOptions,
  UpgradeDecision,
} from './adapter/types.ts';

/**
 * Stateful runtime executor for one compiled server definition.
 *
 * Adapters provide storage, timers, and websocket handles. The engine handles
 * the framework behavior: lifecycle hooks, validation, replay, streams,
 * modules, channel membership, and scheduled work.
 */
export class Engine {
  private readonly options: EngineOptions;
  private readonly compiled: CompiledServer;
  private storage?: StorageProvider;
  private env: Record<string, unknown> = {};
  private timers?: TimerProvider;
  private platform: unknown = {};
  private waitUntilImpl: (promise: Promise<unknown>) => void = () => {};
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
  private readonly activeStreams = new Map<string, ActiveStream>();
  private readonly scheduledRuns = new Map<string, ScheduledRun>();
  private alarmHandle: unknown | null = null;
  private idCounter = 0;
  private seqCounter = 0;
  private readonly moduleRuntimes: ModuleRuntime[] = [];
  private activeConnectionId?: string;
  private initialized = false;

  /**
   * Compile the declarative server definition once up front.
   */
  constructor(handler: ServerDefinition, options: EngineOptions) {
    this.options = options;
    this.compiled = compileHandlerDefinition(handler);
  }

  /**
   * Provide the storage driver the adapter wants the engine to use.
   */
  setStorage(storage: StorageProvider): void {
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
  setTimerProvider(timers: TimerProvider): void {
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
    this.waitUntilImpl = waitUntil;
  }

  /**
   * Read storage or fail with an adapter-specific setup error.
   */
  private requireStorage(): StorageProvider {
    if (!this.storage) {
      throw new Error(`[wskit] storage not provided by adapter "${this.options.adapterId}".`);
    }
    return this.storage;
  }

  /**
   * Read timers or fail with an adapter-specific setup error.
   */
  private requireTimers(): TimerProvider {
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
   * Build the module registration callbacks used during module setup.
   */
  private createModuleHooks(runtime: ModuleRuntime): ModuleHooks<any> {
    return {
      onIncoming: (handler) => {
        runtime.onIncoming = handler;
      },
      onOutgoing: (handler) => {
        runtime.onOutgoing = handler;
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
   * Finish one-time startup work: validate adapter capabilities, install
   * modules, restore schedules, and run the init hook.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.validateRequires();

    for (const moduleInstance of this.compiled.modules) {
      if (moduleInstance.migrate) {
        moduleInstance.migrate(this.requireStorage().sql);
      }

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

    this.restoreScheduledRuns();

    if (this.compiled.lifecycle.onInit) {
      await this.compiled.lifecycle.onInit.handler(this.createInitContext());
    }

    this.rescheduleAlarm();
    this.initialized = true;
  }

  /**
   * Load persisted scheduled runs back into memory.
   */
  private restoreScheduledRuns(): void {
    restoreScheduledRuns({
      storage: this.storage,
      scheduledRuns: this.scheduledRuns,
    });
  }

  /**
   * Persist the in-memory scheduled-run table.
   */
  private persistScheduledRuns(): void {
    persistScheduledRuns({
      storage: this.storage,
      scheduledRuns: this.scheduledRuns,
    });
  }

  /**
   * Build the init hook context from current adapter dependencies.
   */
  private createInitContext() {
    return createInitContext({
      env: this.env,
      logger: this.logger,
      platform: this.platform,
      requireStorage: () => this.requireStorage(),
    });
  }

  /**
   * Build the shutdown hook context from current runtime state.
   */
  private createShutdownContext() {
    return createShutdownContext({
      connections: this.connections,
      env: this.env,
      logger: this.logger,
      platform: this.platform,
      waitUntilImpl: this.waitUntilImpl,
      requireStorage: () => this.requireStorage(),
      requireTimers: () => this.requireTimers(),
      scheduleTask: (taskId, time, data) => this.scheduleTask(taskId, time, data),
      cancelScheduled: (taskId) => this.cancelScheduled(taskId),
      broadcastToConnections: (connections, event, payload, options, excludeConnectionId) =>
        this.broadcastToConnections(connections, event, payload, options, excludeConnectionId),
      sendThroughPipeline: (connection, routing, event, payload) =>
        this.sendThroughPipeline(connection, routing, event, payload),
      broadcastToChannel: (channelName, event, payload, excludeConnectionId, channelScope) =>
        this.broadcastToChannel(channelName, event, payload, excludeConnectionId, channelScope),
      getChannelMembers: (channelName) => this.getChannelMembers(channelName),
      kickChannelMembers: (channelName, tag, reason) =>
        this.kickChannelMembers(channelName, tag, reason),
      sendReplay: (connection, channelName, channelScope, event, payload, wire) =>
        this.sendReplay(connection, channelName, channelScope, event, payload, wire),
      sendProtocolMessage: (connection, event, payload) =>
        this.sendProtocolMessage(connection, event, payload),
      persistAttachment: (connection) => this.persistAttachment(connection),
      toConnectionInfo: (connection) => this.toConnectionInfo(connection),
      attachModuleApis: (ctx, connection) => this.attachModuleApis(ctx, connection),
    });
  }

  /**
   * Build the scheduled-task context from current runtime state.
   */
  private createTaskContext() {
    return createTaskContext({
      connections: this.connections,
      env: this.env,
      logger: this.logger,
      platform: this.platform,
      waitUntilImpl: this.waitUntilImpl,
      requireStorage: () => this.requireStorage(),
      requireTimers: () => this.requireTimers(),
      scheduleTask: (taskId, time, data) => this.scheduleTask(taskId, time, data),
      cancelScheduled: (taskId) => this.cancelScheduled(taskId),
      broadcastToConnections: (connections, event, payload, options, excludeConnectionId) =>
        this.broadcastToConnections(connections, event, payload, options, excludeConnectionId),
      sendThroughPipeline: (connection, routing, event, payload) =>
        this.sendThroughPipeline(connection, routing, event, payload),
      broadcastToChannel: (channelName, event, payload, excludeConnectionId, channelScope) =>
        this.broadcastToChannel(channelName, event, payload, excludeConnectionId, channelScope),
      getChannelMembers: (channelName) => this.getChannelMembers(channelName),
      kickChannelMembers: (channelName, tag, reason) =>
        this.kickChannelMembers(channelName, tag, reason),
      sendReplay: (connection, channelName, channelScope, event, payload, wire) =>
        this.sendReplay(connection, channelName, channelScope, event, payload, wire),
      sendProtocolMessage: (connection, event, payload) =>
        this.sendProtocolMessage(connection, event, payload),
      persistAttachment: (connection) => this.persistAttachment(connection),
      toConnectionInfo: (connection) => this.toConnectionInfo(connection),
      attachModuleApis: (ctx, connection) => this.attachModuleApis(ctx, connection),
    });
  }

  /**
   * Build a live handler context for one connection, optionally scoped to a
   * namespace or channel.
   */
  private buildConnectionContext(
    connection: RuntimeConnection,
    scope?: { namespace?: CompiledNamespace; channel?: CompiledChannel },
  ) {
    return buildConnectionContext(
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
        cancelScheduled: (taskId) => this.cancelScheduled(taskId),
        broadcastToConnections: (connections, event, payload, options, excludeConnectionId) =>
          this.broadcastToConnections(connections, event, payload, options, excludeConnectionId),
        sendThroughPipeline: (connectionArg, routing, event, payload) =>
          this.sendThroughPipeline(connectionArg, routing, event, payload),
        broadcastToChannel: (channelName, event, payload, excludeConnectionId, channelScope) =>
          this.broadcastToChannel(channelName, event, payload, excludeConnectionId, channelScope),
        getChannelMembers: (channelName) => this.getChannelMembers(channelName),
        kickChannelMembers: (channelName, tag, reason) =>
          this.kickChannelMembers(channelName, tag, reason),
        sendReplay: (connectionArg, channelName, channelScope, event, payload, wire) =>
          this.sendReplay(connectionArg, channelName, channelScope, event, payload, wire),
        sendProtocolMessage: (connectionArg, event, payload) =>
          this.sendProtocolMessage(connectionArg, event, payload),
        persistAttachment: (connectionArg) => this.persistAttachment(connectionArg),
        toConnectionInfo: (connectionArg) => this.toConnectionInfo(connectionArg),
        attachModuleApis: (ctx, connectionArg) => this.attachModuleApis(ctx, connectionArg),
      },
      connection,
      scope,
    );
  }

  /**
   * Wrap a context so module event helpers automatically target the module's
   * private event namespace.
   */
  private createModuleScopedContext(moduleId: string, ctx: Record<PropertyKey, unknown>) {
    return createModuleScopedContext(moduleId, ctx);
  }

  /**
   * Attach every installed module API object to a context.
   */
  private attachModuleApis(
    ctx: Record<PropertyKey, unknown>,
    connection?: RuntimeConnection,
  ): void {
    attachModuleApis(this.moduleRuntimes, ctx, connection);
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
    const finalPayload: Record<string, unknown> = {
      ...(payload && typeof payload === 'object'
        ? (payload as Record<string, unknown>)
        : { value: payload }),
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
    return toConnectionInfo(connection);
  }

  /**
   * Ask the adapter to serialize connection attachment data when supported.
   */
  private persistAttachment(connection: RuntimeConnection): void {
    persistAttachment(connection);
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
   * Shared dependency bag for pure outgoing helpers.
   */
  private outgoingRuntime() {
    const engine = this;

    return {
      compiled: this.compiled,
      moduleRuntimes: this.moduleRuntimes,
      seqState: {
        get current() {
          return engine.seqCounter;
        },
        set current(value: number) {
          engine.seqCounter = value;
        },
      },
      generateId: (prefix?: string) => this.generateId(prefix),
    };
  }

  /**
   * Shared dependency bag for helpers that need connection lookups and channel
   * membership state.
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
   * Shared dependency bag for channel subscribe/unsubscribe helpers.
   */
  private channelRuntime() {
    return {
      ...this.memberRuntime(),
      buildConnectionContext: (connection: RuntimeConnection, scope?: ResolvedScope) =>
        this.buildConnectionContext(connection, scope),
      persistAttachment: (connection: RuntimeConnection) => this.persistAttachment(connection),
      sendProtocolMessage: (
        connection: RuntimeConnection,
        event: string,
        payload: Record<string, unknown>,
      ) => this.sendProtocolMessage(connection, event, payload),
    };
  }

  /**
   * Shared dependency bag for inbound text-message dispatch.
   */
  private dispatchRuntime() {
    return {
      ...this.memberRuntime(),
      logger: this.logger,
      activeStreams: this.activeStreams,
      requireTimers: () => this.requireTimers(),
      buildConnectionContext: (connection: RuntimeConnection, scope?: ResolvedScope) =>
        this.buildConnectionContext(connection, scope),
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
      handleSubscribe: (
        connection: RuntimeConnection,
        payload: Record<string, unknown> | undefined,
      ) => this.handleSubscribe(connection, payload),
      handleUnsubscribe: (
        connection: RuntimeConnection,
        payload: Record<string, unknown> | undefined,
      ) => this.handleUnsubscribe(connection, payload),
      handleReplay: (connection: RuntimeConnection, payload: Record<string, unknown> | undefined) =>
        this.handleReplay(connection, payload),
      refreshHeartbeat: (connection: RuntimeConnection) => this.refreshHeartbeat(connection),
    };
  }

  /**
   * Shared dependency bag for accept/wake/close helpers.
   */
  private connectionRuntime() {
    return {
      compiled: this.compiled,
      timers: this.timers,
      connections: this.connections,
      wsToConnectionId: this.wsToConnectionId,
      generateId: (prefix?: string) => this.generateId(prefix),
      persistAttachment: (connection: RuntimeConnection) => this.persistAttachment(connection),
      buildConnectionContext: (connection: RuntimeConnection, scope?: ResolvedScope) =>
        this.buildConnectionContext(connection, scope),
      runConnectionLifecycle: (kind: 'connect' | 'disconnect', ctx: Record<PropertyKey, unknown>) =>
        this.runConnectionLifecycle(kind, ctx),
      processTextMessage: (connection: RuntimeConnection, data: string) =>
        this.processTextMessage(connection, data),
      handleBinaryMessage: (connection: RuntimeConnection, data: ArrayBuffer) =>
        this.handleBinaryMessage(connection, data),
      handleConnectionClose: (connection: RuntimeConnection, code: number, reason: string) =>
        this.handleConnectionClose(connection, code, reason),
      handleRuntimeError: (connection: RuntimeConnection, error: unknown, event?: string) =>
        this.handleRuntimeError(connection, error, event),
    };
  }

  /**
   * Accept a newly upgraded websocket and return the callbacks the adapter uses
   * to drive it.
   */
  accept(wsKey: unknown, descriptor: ConnectionDescriptor): ConnectionHandle {
    return acceptConnection(this.connectionRuntime(), wsKey, descriptor);
  }

  /**
   * Rebuild a connection handle for a websocket the adapter woke from
   * hibernation.
   */
  handleHibernationWake(wsKey: unknown): ConnectionHandle {
    return wakeHibernatedConnection(this.connectionRuntime(), wsKey);
  }

  /**
   * Run the optional upgrade hook before the adapter commits to the websocket
   * handshake.
   */
  async handleUpgrade(request: Request): Promise<UpgradeDecision> {
    return handleUpgrade(
      {
        compiled: this.compiled,
      },
      request,
    );
  }

  /**
   * Shut down the engine and all connection/module activity owned by it.
   */
  async handleShutdown(): Promise<void> {
    const engine = this;
    return handleShutdown({
      compiled: this.compiled,
      connections: this.connections,
      timers: this.timers,
      moduleRuntimes: this.moduleRuntimes,
      createShutdownContext: () => this.createShutdownContext(),
      cancelActiveStreamsForConnection: (connectionId) =>
        this.cancelActiveStreamsForConnection(connectionId),
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
   * Run due scheduled tasks after an alarm/timer wake-up.
   */
  async handleAlarm(): Promise<void> {
    const engine = this;
    return handleAlarm({
      storage: this.storage,
      timers: this.timers,
      scheduledRuns: this.scheduledRuns,
      compiled: this.compiled,
      alarmState: {
        get current() {
          return engine.alarmHandle;
        },
        set current(value: unknown | null) {
          engine.alarmHandle = value;
        },
      },
      generateId: (prefix) => this.generateId(prefix),
      createTaskContext: () => this.createTaskContext() as unknown,
      onAlarm: () => this.handleAlarm(),
    });
  }

  /**
   * Queue one future scheduled task run.
   */
  private scheduleTask(taskId: string, time: number, data: unknown): void {
    scheduleTask(
      {
        compiled: this.compiled,
        scheduledRuns: this.scheduledRuns,
        generateId: (prefix) => this.generateId(prefix),
        persistScheduledRuns: () => this.persistScheduledRuns(),
        rescheduleAlarm: () => this.rescheduleAlarm(),
      },
      taskId,
      time,
      data,
    );
  }

  /**
   * Remove every queued run for a scheduled task id.
   */
  private cancelScheduled(taskId: string): void {
    cancelScheduled(
      {
        scheduledRuns: this.scheduledRuns,
        persistScheduledRuns: () => this.persistScheduledRuns(),
        rescheduleAlarm: () => this.rescheduleAlarm(),
      },
      taskId,
    );
  }

  /**
   * Ask the adapter timer API to wake the engine when the next scheduled task
   * becomes due.
   */
  private rescheduleAlarm(): void {
    const engine = this;
    rescheduleAlarm({
      storage: this.storage,
      timers: this.timers,
      scheduledRuns: this.scheduledRuns,
      compiled: this.compiled,
      alarmState: {
        get current() {
          return engine.alarmHandle;
        },
        set current(value: unknown | null) {
          engine.alarmHandle = value;
        },
      },
      generateId: (prefix) => this.generateId(prefix),
      createTaskContext: () => this.createTaskContext() as unknown,
      onAlarm: () => this.handleAlarm(),
    });
  }

  /**
   * Reset a connection's heartbeat timeout after activity.
   */
  private refreshHeartbeat(connection: RuntimeConnection): void {
    refreshHeartbeat(
      {
        compiled: this.compiled,
        timers: this.timers,
      },
      connection,
    );
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
    return runConnectionLifecycle(
      {
        compiled: this.compiled,
        moduleRuntimes: this.moduleRuntimes,
        activeConnectionState: {
          get current() {
            return engine.activeConnectionId;
          },
          set current(value: string | undefined) {
            engine.activeConnectionId = value;
          },
        },
        createModuleScopedContext: (moduleId, targetCtx) =>
          this.createModuleScopedContext(moduleId, targetCtx),
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
    return handleConnectionClose(
      {
        compiled: this.compiled,
        connections: this.connections,
        wsToConnectionId: this.wsToConnectionId,
        timers: this.timers,
        cancelActiveStreamsForConnection: (connectionId) =>
          this.cancelActiveStreamsForConnection(connectionId),
        buildConnectionContext: (targetConnection, scope) =>
          this.buildConnectionContext(targetConnection, scope),
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
    return cancelActiveStreamsForConnection(
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
    return handleBinaryMessage(
      {
        compiled: this.compiled,
        buildConnectionContext: (targetConnection, scope) =>
          this.buildConnectionContext(targetConnection, scope),
        refreshHeartbeat: (targetConnection) => this.refreshHeartbeat(targetConnection),
      },
      connection,
      data,
    );
  }

  /**
   * Parse and route one websocket text frame.
   */
  private async processTextMessage(connection: RuntimeConnection, data: string): Promise<void> {
    return processTextMessage(this.dispatchRuntime(), connection, data);
  }

  /**
   * Resolve namespace/channel routing markers from an incoming payload.
   */
  private resolveScope(payload: unknown): {
    namespace?: CompiledNamespace;
    channel?: CompiledChannel;
    channelName?: string;
    channelScope?: string;
  } {
    return resolveScope(this.compiled, payload);
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
    return sendThroughPipeline(this.outgoingRuntime(), connection, routing, event, payload);
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
    broadcastToConnections(
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
    broadcastToChannel(
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
    return getChannelMembers(this.memberRuntime(), channelName);
  }

  /**
   * Remove tagged members from a channel, typically for moderation.
   */
  private kickChannelMembers(channelName: string, tag: string, reason: string): void {
    kickChannelMembers(
      {
        ...this.channelRuntime(),
        leaveChannel: (targetConnection, scope, kickedReason) =>
          this.leaveChannel(targetConnection, scope, kickedReason),
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
    return leaveChannel(this.channelRuntime(), connection, scope, kickedReason);
  }

  /**
   * Handle the `_subscribe` protocol message for a channel.
   */
  private async handleSubscribe(
    connection: RuntimeConnection,
    payload: Record<string, unknown> | undefined,
  ): Promise<void> {
    return handleSubscribe(this.channelRuntime(), connection, payload);
  }

  /**
   * Handle the `_unsubscribe` protocol message for a channel.
   */
  private async handleUnsubscribe(
    connection: RuntimeConnection,
    payload: Record<string, unknown> | undefined,
  ): Promise<void> {
    return handleUnsubscribe(
      {
        ...this.channelRuntime(),
        leaveChannel: (targetConnection, scope) => this.leaveChannel(targetConnection, scope),
      },
      connection,
      payload,
    );
  }

  /**
   * Handle the `_replay` protocol message for the active scope.
   */
  private async handleReplay(
    connection: RuntimeConnection,
    payload: Record<string, unknown> | undefined,
  ): Promise<void> {
    return handleReplay(
      {
        compiled: this.compiled,
        buildConnectionContext: (targetConnection, scope) =>
          this.buildConnectionContext(targetConnection, scope),
      },
      connection,
      payload,
      (value) => this.resolveScope(value),
    );
  }

  /**
   * Normalize an error and send the engine `_error` protocol message unless the
   * error hook explicitly suppresses it.
   */
  private async handleRuntimeError(
    connection: RuntimeConnection,
    error: unknown,
    event?: string,
    routing?: Record<string, unknown>,
  ): Promise<void> {
    return handleRuntimeError(
      {
        compiled: this.compiled,
        buildConnectionContext: (targetConnection, scope) =>
          this.buildConnectionContext(targetConnection, scope),
        sendProtocolMessage: (targetConnection, outgoingEvent, payload) =>
          this.sendProtocolMessage(targetConnection, outgoingEvent, payload),
      },
      connection,
      error,
      event,
      routing,
    );
  }
}
