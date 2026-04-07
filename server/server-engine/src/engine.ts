/* oxlint-disable @typescript-eslint/no-explicit-any */
import { Block, CloseCodes, Skip, ValidationFailed, WskitError } from '@wskit/core';
import { DeferExhausted } from '@wskit/server-codegen/errors';
import { MODULE_API_MAP } from '@wskit/server-codegen/internal/define-module';
import type {
  BroadcastOptions,
  ConnectionContext,
  ConnectionInfo,
  InitContext,
  Logger,
  ShutdownContext,
  StorageProvider,
  TaskContext,
  TimerProvider,
} from '@wskit/server-codegen';
import type { ChannelPrimitive, ScopeDeclaration } from '@wskit/server-codegen/channel';
import type { ErrorsPrimitive } from '@wskit/server-codegen/errors/errors';
import type { HibernationPrimitive } from '@wskit/server-codegen/hibernation';
import type { IncomingPrimitive } from '@wskit/server-codegen/incoming';
import type {
  PostInterceptPrimitive,
  PreInterceptPrimitive,
} from '@wskit/server-codegen/intercept';
import type { ModuleHooks, ModuleInstance } from '@wskit/server-codegen/internal/define-module';
import type { ServerDefinition } from '@wskit/server-codegen/internal/define-server';
import type {
  BeforeSubscribePrimitive,
  BinaryPrimitive,
  ConnectPrimitive,
  DisconnectPrimitive,
  ErrorPrimitive,
  InitPrimitive,
  ShutdownPrimitive,
  SubscribePrimitive,
  UnsubscribePrimitive,
  UpgradePrimitive,
  ValidationErrorPrimitive,
} from '@wskit/server-codegen/lifecycle';
import type { NamespacePrimitive } from '@wskit/server-codegen/namespace';
import type { OutgoingPrimitive } from '@wskit/server-codegen/outgoing';
import type { PassivePrimitive } from '@wskit/server-codegen/passive';
import type { Primitive, RequiresManifest } from '@wskit/server-codegen/primitive';
import type { ReplayPrimitive } from '@wskit/server-codegen/replay';
import type { RequestPrimitive } from '@wskit/server-codegen/request';
import type { ScheduledPrimitive } from '@wskit/server-codegen/scheduled';
import type {
  GeneratePrimitive,
  NudgeDeclaration,
  StreamPrimitive,
} from '@wskit/server-codegen/stream';

export interface ConnectionDescriptor {
  send(data: string): void;
  sendBinary(data: ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  bufferedAmount(): number;
  meta?: Record<string, unknown>;
  tags?: readonly string[];
}

export interface ConnectionHandle {
  handleMessage(data: string): void;
  handleBinary(data: ArrayBuffer): void;
  handleClose(code: number, reason: string): void;
  handleError(error: unknown): void;
}

export interface UpgradeDecision {
  reject?: boolean;
  code?: number;
  reason?: string;
  meta?: Record<string, unknown>;
  tags?: readonly string[];
}

export interface EngineOptions {
  adapterId: string;
  hibernation: boolean;
}

export interface AdapterConfig<TOptions, TService> {
  id: string;
  hibernation: boolean;
  setup(handler: ServerDefinition, engine: Engine, options: TOptions): TService | Promise<TService>;
}

type AnyOutgoing = OutgoingPrimitive<string, any>;
type AnyIncoming = IncomingPrimitive<string, any, any>;
type AnyRequest = RequestPrimitive<string, any, any, any>;
type AnyGenerate = GeneratePrimitive<
  StreamPrimitive<string, any, any, readonly NudgeDeclaration[]>,
  any,
  any
>;
type AnyPreIntercept = PreInterceptPrimitive<any>;
type AnyPostIntercept = PostInterceptPrimitive<string, any, any>;
type AnyScheduled = ScheduledPrimitive<string, any, any>;
type AnyModule = ModuleInstance<string, any, any, readonly AnyOutgoing[], readonly any[]>;

interface CompiledNamespace {
  kind: 'namespace';
  name: string;
  outgoing: Map<string, AnyOutgoing>;
  incoming: Map<string, AnyIncoming>;
  requests: Map<string, AnyRequest>;
  streams: Map<string, AnyGenerate>;
  preIntercepts: AnyPreIntercept[];
  postIntercepts: Map<string, AnyPostIntercept[]>;
}

interface CompiledChannel {
  kind: 'channel';
  key: string;
  pattern: string | ScopeDeclaration<string>;
  outgoing: Map<string, AnyOutgoing>;
  incoming: Map<string, AnyIncoming>;
  requests: Map<string, AnyRequest>;
  streams: Map<string, AnyGenerate>;
  preIntercepts: AnyPreIntercept[];
  postIntercepts: Map<string, AnyPostIntercept[]>;
  replay?: ReplayPrimitive<any>;
  onBeforeSubscribe?: BeforeSubscribePrimitive<any, any>;
  onSubscribe?: SubscribePrimitive<any>;
  onUnsubscribe?: UnsubscribePrimitive<any>;
}

interface CompiledServer {
  outgoing: Map<string, AnyOutgoing>;
  incoming: Map<string, AnyIncoming>;
  requests: Map<string, AnyRequest>;
  streams: Map<string, AnyGenerate>;
  preIntercepts: AnyPreIntercept[];
  postIntercepts: Map<string, AnyPostIntercept[]>;
  namespaces: Map<string, CompiledNamespace>;
  channels: Map<string, CompiledChannel>;
  channelFamilies: Map<string, CompiledChannel>;
  scheduled: Map<string, AnyScheduled>;
  modules: AnyModule[];
  errors: ErrorsPrimitive<any>[];
  ack: boolean;
  sequence: boolean;
  dedup: boolean;
  replay?: ReplayPrimitive<any>;
  heartbeatTimeout?: number;
  hibernationEnabled: boolean;
  lifecycle: {
    onInit?: InitPrimitive<any>;
    onConnect?: ConnectPrimitive<any>;
    onDisconnect?: DisconnectPrimitive<any>;
    onShutdown?: ShutdownPrimitive<any>;
    onError?: ErrorPrimitive<any>;
    onUpgrade?: UpgradePrimitive;
    onBinary?: BinaryPrimitive<any>;
    onValidationError?: ValidationErrorPrimitive<any>;
  };
  requires: RequiresManifest;
}

interface RuntimeConnection {
  id: string;
  wsKey: unknown;
  descriptor: ConnectionDescriptor;
  meta: Record<string, unknown>;
  tags: Set<string>;
  channels: Set<string>;
  latency: number | null;
  quality: 'excellent' | 'good' | 'degraded' | 'poor';
  activeAckId?: string;
  heartbeatTimer?: unknown;
}

interface ScheduledRun {
  id: string;
  taskId: string;
  time: number;
  data: unknown;
  every?: number;
}

interface ActiveStream {
  id: string;
  connectionId: string;
  generator: AsyncGenerator<unknown, void, unknown>;
  nudges: { event: string; payload: unknown }[];
  nudgeValidators: Map<string, unknown>;
  closed: boolean;
}

interface ModuleRuntime {
  instance: AnyModule;
  onIncoming?: (message: {
    event: string;
    payload: unknown;
  }) => { event: string; payload: unknown } | void;
  onOutgoing?: (message: {
    event: string;
    payload: unknown;
  }) => { event: string; payload: unknown } | void;
  onConnect?: (ctx: any) => void | Promise<void>;
  onDisconnect?: (ctx: any) => void | Promise<void>;
  onShutdown?: () => void | Promise<void>;
  contextFactory: (ctx: any) => unknown;
}

function isPassivePrimitive(primitive: Primitive): primitive is PassivePrimitive<any> {
  return primitive.__wskit === 'passive';
}

function isNamespacePrimitive(primitive: Primitive): primitive is NamespacePrimitive {
  return primitive.__wskit === 'namespace';
}

function isChannelPrimitive(primitive: Primitive): primitive is ChannelPrimitive {
  return primitive.__wskit === 'channel';
}

function mergeRequires(target: RequiresManifest, source: RequiresManifest): void {
  if (source.storage) target.storage = true;
  if (source.timers) target.timers = true;
  if (source.hibernation) target.hibernation = true;
}

function validateValue(validator: unknown, value: unknown, event = 'unknown'): unknown {
  if (!validator) return value;

  if (typeof validator === 'function') {
    return validator(value);
  }

  if (
    validator &&
    typeof validator === 'object' &&
    '~standard' in (validator as object) &&
    typeof (validator as { '~standard'?: { validate?: (value: unknown) => unknown } })['~standard']
      ?.validate === 'function'
  ) {
    const result = (validator as { '~standard': { validate(value: unknown): unknown } })[
      '~standard'
    ].validate(value);

    if (result && typeof result === 'object' && 'issues' in (result as object)) {
      throw ValidationFailed({
        event,
        issues: (result as { issues: { message: string; path?: (string | number)[] }[] }).issues,
      });
    }

    if (result && typeof result === 'object' && 'value' in (result as object)) {
      return (result as { value: unknown }).value;
    }

    return result;
  }

  return value;
}

function prefixedModuleEvent(moduleId: string, event: string): string {
  return `__${moduleId}:${event}`;
}

function addPostIntercept(
  event: string,
  primitive: AnyPostIntercept,
  map: Map<string, AnyPostIntercept[]>,
): void {
  const existing = map.get(event) ?? [];
  existing.push(primitive);
  map.set(event, existing);
}

function compileNamespace(primitive: NamespacePrimitive): CompiledNamespace {
  const scope: CompiledNamespace = {
    kind: 'namespace',
    name: primitive.pattern,
    outgoing: new Map(),
    incoming: new Map(),
    requests: new Map(),
    streams: new Map(),
    preIntercepts: [],
    postIntercepts: new Map(),
  };

  for (const child of primitive.primitives) {
    if (child.__wskit === 'outgoing') scope.outgoing.set(child.event, child as AnyOutgoing);
    else if (child.__wskit === 'incoming') scope.incoming.set(child.event, child as AnyIncoming);
    else if (child.__wskit === 'request') scope.requests.set(child.event, child as AnyRequest);
    else if (child.__wskit === 'generate') scope.streams.set(child.event, child as AnyGenerate);
    else if (child.__wskit === 'intercept') {
      const intercept = child as AnyPreIntercept | AnyPostIntercept;
      if (intercept.mode === 'pre') scope.preIntercepts.push(intercept);
      else addPostIntercept(intercept.event, intercept, scope.postIntercepts);
    }
  }

  return scope;
}

function compileChannel(primitive: ChannelPrimitive): CompiledChannel {
  const key = typeof primitive.pattern === 'string' ? primitive.pattern : primitive.pattern.key;
  const scope: CompiledChannel = {
    kind: 'channel',
    key,
    pattern: primitive.pattern,
    outgoing: new Map(),
    incoming: new Map(),
    requests: new Map(),
    streams: new Map(),
    preIntercepts: [],
    postIntercepts: new Map(),
  };

  for (const child of primitive.primitives) {
    if (child.__wskit === 'outgoing') scope.outgoing.set(child.event, child as AnyOutgoing);
    else if (child.__wskit === 'incoming') scope.incoming.set(child.event, child as AnyIncoming);
    else if (child.__wskit === 'request') scope.requests.set(child.event, child as AnyRequest);
    else if (child.__wskit === 'generate') scope.streams.set(child.event, child as AnyGenerate);
    else if (child.__wskit === 'replay') scope.replay = child as ReplayPrimitive<any>;
    else if (child.__wskit === 'intercept') {
      const intercept = child as AnyPreIntercept | AnyPostIntercept;
      if (intercept.mode === 'pre') scope.preIntercepts.push(intercept);
      else addPostIntercept(intercept.event, intercept, scope.postIntercepts);
    } else if (child.__wskit === 'onBeforeSubscribe') {
      scope.onBeforeSubscribe = child as BeforeSubscribePrimitive<any, any>;
    } else if (child.__wskit === 'onSubscribe') {
      scope.onSubscribe = child as SubscribePrimitive<any>;
    } else if (child.__wskit === 'onUnsubscribe') {
      scope.onUnsubscribe = child as UnsubscribePrimitive<any>;
    }
  }

  return scope;
}

function visitCompiledPrimitives(compiled: CompiledServer, primitives: readonly Primitive[]): void {
  for (const primitive of primitives) {
    mergeRequires(compiled.requires, primitive.__requires);

    if (isPassivePrimitive(primitive)) {
      visitCompiledPrimitives(compiled, primitive.primitives);
      continue;
    }

    if (primitive.__wskit === 'ack') compiled.ack = true;
    else if (primitive.__wskit === 'replay') compiled.replay = primitive as ReplayPrimitive<any>;
    else if (primitive.__wskit === 'sequence') compiled.sequence = true;
    else if (primitive.__wskit === 'dedup') compiled.dedup = true;
    else if (primitive.__wskit === 'heartbeat')
      compiled.heartbeatTimeout = (primitive as any).timeout;
    else if (primitive.__wskit === 'hibernation') {
      compiled.hibernationEnabled = (primitive as HibernationPrimitive).enabled;
    } else if (primitive.__wskit === 'outgoing') {
      compiled.outgoing.set((primitive as AnyOutgoing).event, primitive as AnyOutgoing);
    } else if (primitive.__wskit === 'incoming') {
      compiled.incoming.set((primitive as AnyIncoming).event, primitive as AnyIncoming);
    } else if (primitive.__wskit === 'request') {
      compiled.requests.set((primitive as AnyRequest).event, primitive as AnyRequest);
    } else if (primitive.__wskit === 'generate') {
      compiled.streams.set((primitive as AnyGenerate).event, primitive as AnyGenerate);
    } else if (primitive.__wskit === 'scheduled') {
      compiled.scheduled.set((primitive as AnyScheduled).taskId, primitive as AnyScheduled);
    } else if (primitive.__wskit === 'intercept') {
      const intercept = primitive as AnyPreIntercept | AnyPostIntercept;
      if (intercept.mode === 'pre') compiled.preIntercepts.push(intercept);
      else addPostIntercept(intercept.event, intercept, compiled.postIntercepts);
    } else if (primitive.__wskit === 'errors') {
      compiled.errors.push(primitive as ErrorsPrimitive<any>);
    } else if (primitive.__wskit === 'module') {
      compiled.modules.push(primitive as AnyModule);
    } else if (primitive.__wskit === 'onInit') {
      compiled.lifecycle.onInit = primitive as InitPrimitive<any>;
    } else if (primitive.__wskit === 'onConnect') {
      compiled.lifecycle.onConnect = primitive as ConnectPrimitive<any>;
    } else if (primitive.__wskit === 'onDisconnect') {
      compiled.lifecycle.onDisconnect = primitive as DisconnectPrimitive<any>;
    } else if (primitive.__wskit === 'onShutdown') {
      compiled.lifecycle.onShutdown = primitive as ShutdownPrimitive<any>;
    } else if (primitive.__wskit === 'onError') {
      compiled.lifecycle.onError = primitive as ErrorPrimitive<any>;
    } else if (primitive.__wskit === 'onUpgrade') {
      compiled.lifecycle.onUpgrade = primitive as UpgradePrimitive;
    } else if (primitive.__wskit === 'onBinary') {
      compiled.lifecycle.onBinary = primitive as BinaryPrimitive<any>;
    } else if (primitive.__wskit === 'onValidationError') {
      compiled.lifecycle.onValidationError = primitive as ValidationErrorPrimitive<any>;
    } else if (isNamespacePrimitive(primitive)) {
      compiled.namespaces.set(primitive.pattern, compileNamespace(primitive));
    } else if (isChannelPrimitive(primitive)) {
      const compiledChannel = compileChannel(primitive);
      if (typeof primitive.pattern === 'string')
        compiled.channels.set(primitive.pattern, compiledChannel);
      else compiled.channelFamilies.set(primitive.pattern.key, compiledChannel);
    }
  }
}

function compileHandlerDefinition(handler: ServerDefinition): CompiledServer {
  const compiled: CompiledServer = {
    outgoing: new Map(),
    incoming: new Map(),
    requests: new Map(),
    streams: new Map(),
    preIntercepts: [],
    postIntercepts: new Map(),
    namespaces: new Map(),
    channels: new Map(),
    channelFamilies: new Map(),
    scheduled: new Map(),
    modules: [],
    errors: [],
    ack: false,
    sequence: false,
    dedup: false,
    hibernationEnabled: false,
    lifecycle: {},
    requires: {},
  };

  visitCompiledPrimitives(compiled, handler.primitives);
  return compiled;
}

export class Engine {
  private readonly options: EngineOptions;
  private readonly compiled: CompiledServer;
  private storage?: StorageProvider;
  private env: Record<string, unknown> = {};
  private timers?: TimerProvider;
  private platform: unknown = {};
  private waitUntilImpl: (promise: Promise<unknown>) => void = () => {};
  private readonly logger: Logger = {
    info(message, data) {
      console.log(message, data ?? {});
    },
    warn(message, data) {
      console.warn(message, data ?? {});
    },
    error(message, data) {
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

  constructor(handler: ServerDefinition, options: EngineOptions) {
    this.options = options;
    this.compiled = compileHandlerDefinition(handler);
  }

  setStorage(storage: StorageProvider): void {
    this.storage = storage;
  }

  setEnv(env: Record<string, unknown>): void {
    this.env = env;
  }

  setTimerProvider(timers: TimerProvider): void {
    this.timers = timers;
  }

  setPlatform(platform: unknown): void {
    this.platform = platform;
  }

  setWaitUntil(waitUntil: (promise: Promise<unknown>) => void): void {
    this.waitUntilImpl = waitUntil;
  }

  private requireStorage(): StorageProvider {
    if (!this.storage) {
      throw new Error(`[wskit] storage not provided by adapter "${this.options.adapterId}".`);
    }
    return this.storage;
  }

  private requireTimers(): TimerProvider {
    if (!this.timers) {
      throw new Error(`[wskit] timers not provided by adapter "${this.options.adapterId}".`);
    }
    return this.timers;
  }

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

  private createModuleHooks(runtime: ModuleRuntime): ModuleHooks<any> {
    return {
      onIncoming: (
        handler: (message: {
          event: string;
          payload: unknown;
        }) => { event: string; payload: unknown } | void,
      ) => {
        runtime.onIncoming = handler;
      },
      onOutgoing: (
        handler: (message: {
          event: string;
          payload: unknown;
        }) => { event: string; payload: unknown } | void,
      ) => {
        runtime.onOutgoing = handler;
      },
      onConnect: (handler: (ctx: any) => void | Promise<void>) => {
        runtime.onConnect = handler;
      },
      onDisconnect: (handler: (ctx: any) => void | Promise<void>) => {
        runtime.onDisconnect = handler;
      },
      onShutdown: (handler: () => void | Promise<void>) => {
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

    await this.restoreScheduledRuns();

    if (this.compiled.lifecycle.onInit) {
      await this.compiled.lifecycle.onInit.handler(this.createInitContext());
    }

    this.rescheduleAlarm();
    this.initialized = true;
  }

  private async restoreScheduledRuns(): Promise<void> {
    if (!this.storage) return;

    this.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS _wskit_scheduled (id TEXT PRIMARY KEY, taskId TEXT NOT NULL, time INTEGER NOT NULL, data TEXT, everyMs INTEGER)',
    );

    const rows = this.storage.sql
      .exec('SELECT id, taskId, time, data, everyMs FROM _wskit_scheduled')
      .toArray();

    for (const row of rows) {
      this.scheduledRuns.set(String(row.id), {
        id: String(row.id),
        taskId: String(row.taskId),
        time: Number(row.time),
        data:
          typeof row.data === 'string' && row.data.length > 0 ? JSON.parse(row.data) : undefined,
        every: row.everyMs == null ? undefined : Number(row.everyMs),
      });
    }
  }

  private persistScheduledRuns(): void {
    if (!this.storage) return;
    const runs = [...this.scheduledRuns.values()];
    this.storage.sql.transaction((tx) => {
      tx.exec('DELETE FROM _wskit_scheduled');
      for (const run of runs) {
        tx.exec(
          'INSERT INTO _wskit_scheduled (id, taskId, time, data, everyMs) VALUES (?, ?, ?, ?, ?)',
          run.id,
          run.taskId,
          run.time,
          run.data === undefined ? null : JSON.stringify(run.data),
          run.every ?? null,
        );
      }
    });
  }

  private createInitContext(): InitContext<Record<string, unknown>, unknown> {
    const storage = this.requireStorage();
    return {
      sql: storage.sql,
      kv: storage.kv,
      env: this.env,
      log: this.logger,
      platform: this.platform,
    };
  }

  private createShutdownContext(): ShutdownContext<
    Record<string, unknown>,
    Record<string, unknown>,
    unknown
  > {
    const storage = this.requireStorage();
    return {
      closeAll: (code, reason) => {
        for (const connection of this.connections.values()) {
          connection.descriptor.close(code, reason);
        }
      },
      broadcast: (event, payload, options) => {
        this.broadcastToConnections([...this.connections.values()], event, payload, options);
      },
      sql: storage.sql,
      kv: storage.kv,
      schedule: (taskId, options) => {
        this.scheduleTask(taskId, options.time, options.data);
      },
      cancelScheduled: (taskId) => {
        this.cancelScheduled(taskId);
      },
      connectionCount: this.connections.size,
      getConnections: () =>
        [...this.connections.values()].map((connection) => this.toConnectionInfo(connection)),
      getConnectionsByTag: (tag) =>
        [...this.connections.values()]
          .filter((connection) => connection.tags.has(tag))
          .map((connection) => this.toConnectionInfo(connection)),
      env: this.env,
      log: this.logger,
      waitUntil: this.waitUntilImpl,
      platform: this.platform,
    };
  }

  private createTaskContext(): TaskContext<
    Record<string, unknown>,
    Record<string, unknown>,
    unknown
  > {
    const storage = this.requireStorage();
    const ctx: TaskContext<Record<string, unknown>, Record<string, unknown>, unknown> = {
      sql: storage.sql,
      kv: storage.kv,
      broadcast: (event, payload, options) => {
        this.broadcastToConnections([...this.connections.values()], event, payload, options);
      },
      sendTo: (tag, event, payload) => {
        for (const connection of this.connections.values()) {
          if (connection.tags.has(tag)) {
            this.sendThroughPipeline(connection, undefined, event, payload);
          }
        }
      },
      sendToConnection: (connectionId, event, payload) => {
        const connection = this.connections.get(connectionId);
        if (!connection) return false;
        this.sendThroughPipeline(connection, undefined, event, payload);
        return true;
      },
      getConnections: () =>
        [...this.connections.values()].map((connection) => this.toConnectionInfo(connection)),
      getConnectionsByTag: (tag) =>
        [...this.connections.values()]
          .filter((connection) => connection.tags.has(tag))
          .map((connection) => this.toConnectionInfo(connection)),
      connectionCount: this.connections.size,
      schedule: (taskId, options) => {
        this.scheduleTask(taskId, options.time, options.data);
      },
      cancelScheduled: (taskId) => {
        this.cancelScheduled(taskId);
      },
      env: this.env,
      log: this.logger,
      waitUntil: this.waitUntilImpl,
      platform: this.platform,
    };

    this.attachModuleApis(ctx as unknown as Record<PropertyKey, unknown>, undefined);
    return ctx;
  }

  private buildConnectionContext(
    connection: RuntimeConnection,
    scope?: { namespace?: CompiledNamespace; channel?: CompiledChannel },
  ): ConnectionContext<Record<string, unknown>, Record<string, unknown>, unknown> &
    Record<PropertyKey, unknown> {
    const storage = this.requireStorage();
    const base: ConnectionContext<Record<string, unknown>, Record<string, unknown>, unknown> &
      Record<PropertyKey, unknown> = {
      id: connection.id,
      meta: connection.meta,
      tags: [...connection.tags],
      tag: (label) => {
        connection.tags.add(label);
        this.persistAttachment(connection);
      },
      untag: (label) => {
        connection.tags.delete(label);
        this.persistAttachment(connection);
      },
      send: (event, payload) => this.sendThroughPipeline(connection, undefined, event, payload),
      broadcast: (event, payload, options) => {
        this.broadcastToConnections(
          [...this.connections.values()],
          event,
          payload,
          options,
          connection.id,
        );
      },
      sendTo: (tag, event, payload) => {
        for (const target of this.connections.values()) {
          if (target.tags.has(tag)) {
            this.sendThroughPipeline(target, undefined, event, payload);
          }
        }
      },
      sendToConnection: (connectionId, event, payload) => {
        const target = this.connections.get(connectionId);
        if (!target) return false;
        this.sendThroughPipeline(target, undefined, event, payload);
        return true;
      },
      sendBinary: (data) => {
        connection.descriptor.sendBinary(data);
        return true;
      },
      broadcastBinary: (data, options) => {
        for (const target of this.connections.values()) {
          if (options?.excludeSelf && target.id === connection.id) continue;
          target.descriptor.sendBinary(data);
        }
      },
      close: (code, reason) => connection.descriptor.close(code, reason),
      getConnections: () =>
        [...this.connections.values()].map((target) => this.toConnectionInfo(target)),
      getConnectionsByTag: (tag) =>
        [...this.connections.values()]
          .filter((target) => target.tags.has(tag))
          .map((target) => this.toConnectionInfo(target)),
      connectionCount: this.connections.size,
      bufferedAmount: connection.descriptor.bufferedAmount(),
      latency: connection.latency,
      quality: connection.quality,
      schedule: (taskId, options) => {
        this.scheduleTask(taskId, options.time, options.data);
      },
      cancelScheduled: (taskId) => {
        this.cancelScheduled(taskId);
      },
      setAlarm: (time) => {
        const timers = this.requireTimers();
        if (timers.setAlarm) {
          void timers.setAlarm(time);
        } else {
          this.rescheduleAlarm();
        }
      },
      sql: storage.sql,
      kv: storage.kv,
      env: this.env,
      log: this.logger,
      waitUntil: this.waitUntilImpl,
      platform: this.platform,
    };

    if (scope?.namespace) {
      const namespace = scope.namespace;
      base.namespace = {
        name: namespace.name,
        send: (event, payload) =>
          this.sendThroughPipeline(connection, { namespace: namespace.name }, event, payload),
        broadcast: (event, payload) =>
          this.broadcastToConnections(
            [...this.connections.values()],
            event,
            payload,
            { namespace: namespace.name },
            connection.id,
          ),
      };
    }

    if (scope?.channel) {
      const channel = scope.channel;
      const channelName = typeof channel.pattern === 'string' ? channel.pattern : '';
      base.channel = {
        name: channelName,
        send: (event, payload) =>
          this.sendThroughPipeline(
            connection,
            { channel: channelName, channelScope: channel.key },
            event,
            payload,
          ),
        broadcast: (event, payload) =>
          this.broadcastToChannel(channelName, event, payload, connection.id, channel.key),
        sendReplay: (event, payload, wire) =>
          this.sendReplay(connection, channelName, channel.key, event, payload, wire),
      };
      base.channels = {
        members: (name) => this.getChannelMembers(name),
        kick: (channelNameToKick, tag, reason) =>
          this.kickChannelMembers(channelNameToKick, tag, reason),
      };
    }

    if (this.compiled.ack && !scope?.namespace && !scope?.channel) {
      base.ack = () => {
        if (!connection.activeAckId) return;
        this.sendProtocolMessage(connection, '_ack', { _ackId: connection.activeAckId });
      };
    }

    if (this.compiled.replay && !scope?.namespace && !scope?.channel) {
      base.sendReplay = (
        event: string,
        payload: unknown,
        wire: { seq: number; messageId: string; channel?: string },
      ) => {
        this.sendReplay(connection, wire.channel, undefined, event, payload, wire);
      };
    }

    this.attachModuleApis(base, connection);
    return base;
  }

  private createModuleScopedContext(
    moduleId: string,
    ctx: Record<PropertyKey, unknown>,
  ): Record<PropertyKey, unknown> {
    function prefix(event: string): string {
      return prefixedModuleEvent(moduleId, event);
    }

    return new Proxy(ctx, {
      get(target, key, receiver) {
        if (key === 'send') {
          return (event: string, payload: unknown) =>
            (Reflect.get(target, 'send', receiver) as (event: string, payload: unknown) => void)(
              prefix(event),
              payload,
            );
        }
        if (key === 'broadcast') {
          return (event: string, payload: unknown, options?: BroadcastOptions) =>
            (
              Reflect.get(target, 'broadcast', receiver) as (
                event: string,
                payload: unknown,
                options?: BroadcastOptions,
              ) => void
            )(prefix(event), payload, options);
        }
        if (key === 'sendTo') {
          return (tag: string, event: string, payload: unknown) =>
            (
              Reflect.get(target, 'sendTo', receiver) as (
                tag: string,
                event: string,
                payload: unknown,
              ) => void
            )(tag, prefix(event), payload);
        }
        if (key === 'sendToConnection') {
          return (connectionId: string, event: string, payload: unknown) =>
            (
              Reflect.get(target, 'sendToConnection', receiver) as (
                connectionId: string,
                event: string,
                payload: unknown,
              ) => boolean
            )(connectionId, prefix(event), payload);
        }
        return Reflect.get(target, key, receiver);
      },
    });
  }

  private attachModuleApis(
    ctx: Record<PropertyKey, unknown>,
    connection?: RuntimeConnection,
  ): void {
    const apiMap: Record<PropertyKey, unknown> = {};

    for (const runtime of this.moduleRuntimes) {
      const moduleCtx = this.createModuleScopedContext(runtime.instance.id, ctx);
      const api = runtime.contextFactory(moduleCtx);
      apiMap[(runtime.instance as Primitive).__identity[0]] = api;

      if (connection) {
        apiMap[runtime.instance.id] = api;
      }
    }

    Object.defineProperty(ctx, MODULE_API_MAP, {
      configurable: true,
      enumerable: false,
      value: apiMap,
      writable: false,
    });
  }

  private sendProtocolMessage(
    connection: RuntimeConnection,
    event: string,
    payload: Record<string, unknown>,
  ): void {
    connection.descriptor.send(JSON.stringify({ event, payload }));
  }

  private isDeclaredModuleEvent(event: string): boolean {
    for (const moduleInstance of this.compiled.modules) {
      for (const declaration of moduleInstance.outgoing) {
        if (prefixedModuleEvent(moduleInstance.id, declaration.event) === event) {
          return true;
        }
      }
    }

    return false;
  }

  private isDeclaredOutgoingEvent(
    event: string,
    routing?:
      | {
          namespace?: string;
          channel?: string;
          channelScope?: string;
        }
      | undefined,
  ): boolean {
    if (event.startsWith('_')) return true;
    if (event.startsWith('__')) return this.isDeclaredModuleEvent(event);

    if (routing?.namespace) {
      const namespace = this.compiled.namespaces.get(routing.namespace);
      return (namespace?.outgoing.has(event) ?? false) || (namespace?.streams.has(event) ?? false);
    }

    if (routing?.channel) {
      const channel = routing.channelScope
        ? this.compiled.channelFamilies.get(routing.channelScope)
        : this.compiled.channels.get(routing.channel);
      return (channel?.outgoing.has(event) ?? false) || (channel?.streams.has(event) ?? false);
    }

    return this.compiled.outgoing.has(event) || this.compiled.streams.has(event);
  }

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

  private toConnectionInfo(connection: RuntimeConnection): ConnectionInfo<Record<string, unknown>> {
    return {
      id: connection.id,
      meta: connection.meta,
      tags: [...connection.tags],
      channels: [...connection.channels],
      latency: connection.latency,
      quality: connection.quality,
      bufferedAmount: connection.descriptor.bufferedAmount(),
    };
  }

  private persistAttachment(connection: RuntimeConnection): void {
    const wsLike = connection.wsKey as { serializeAttachment?: (value: unknown) => void };
    if (typeof wsLike.serializeAttachment === 'function') {
      wsLike.serializeAttachment({
        id: connection.id,
        meta: connection.meta,
        tags: [...connection.tags],
        channels: [...connection.channels],
      });
    }
  }

  private generateId(prefix = 'id'): string {
    this.idCounter += 1;
    return `${prefix}_${this.idCounter}`;
  }

  accept(wsKey: unknown, descriptor: ConnectionDescriptor): ConnectionHandle {
    const connection: RuntimeConnection = {
      id: this.generateId('conn'),
      wsKey,
      descriptor,
      meta: descriptor.meta ?? {},
      tags: new Set(descriptor.tags ?? []),
      channels: new Set(),
      latency: null,
      quality: 'good',
    };

    this.connections.set(connection.id, connection);
    this.wsToConnectionId.set(wsKey, connection.id);
    this.persistAttachment(connection);
    this.installHeartbeat(connection);

    const ctx = this.buildConnectionContext(connection);
    void this.runConnectionLifecycle('connect', ctx);

    return {
      handleMessage: (data) => {
        void this.processTextMessage(connection, data);
      },
      handleBinary: (data) => {
        void this.handleBinaryMessage(connection, data);
      },
      handleClose: (code, reason) => {
        void this.handleConnectionClose(connection, code, reason);
      },
      handleError: (error) => {
        void this.handleRuntimeError(connection, error, undefined);
      },
    };
  }

  handleHibernationWake(wsKey: unknown): ConnectionHandle {
    const existingId = this.wsToConnectionId.get(wsKey);
    if (existingId) {
      const existing = this.connections.get(existingId)!;
      return {
        handleMessage: (data) => {
          void this.processTextMessage(existing, data);
        },
        handleBinary: (data) => {
          void this.handleBinaryMessage(existing, data);
        },
        handleClose: (code, reason) => {
          void this.handleConnectionClose(existing, code, reason);
        },
        handleError: (error) => {
          void this.handleRuntimeError(existing, error, undefined);
        },
      };
    }

    const wsLike = wsKey as {
      send?(data: string | ArrayBuffer | ArrayBufferView): void;
      close?(code?: number, reason?: string): void;
      serializeAttachment?(value: unknown): void;
      deserializeAttachment?(): unknown;
    };
    const attachment =
      typeof wsLike.deserializeAttachment === 'function' ? wsLike.deserializeAttachment() : {};
    const restored =
      attachment && typeof attachment === 'object' ? (attachment as Record<string, unknown>) : {};

    const descriptor: ConnectionDescriptor = {
      send: (data) => wsLike.send?.(data),
      sendBinary: (data) => wsLike.send?.(data),
      close: (code, reason) => wsLike.close?.(code, reason),
      bufferedAmount: () => 0,
      meta: (restored.meta as Record<string, unknown>) ?? {},
      tags: (restored.tags as string[]) ?? [],
    };
    const connection: RuntimeConnection = {
      id: typeof restored.id === 'string' ? restored.id : this.generateId('conn'),
      wsKey,
      descriptor,
      meta: (restored.meta as Record<string, unknown>) ?? {},
      tags: new Set((restored.tags as string[]) ?? []),
      channels: new Set((restored.channels as string[]) ?? []),
      latency: null,
      quality: 'good',
    };

    this.connections.set(connection.id, connection);
    this.wsToConnectionId.set(wsKey, connection.id);
    this.persistAttachment(connection);
    this.installHeartbeat(connection);

    return {
      handleMessage: (data) => {
        void this.processTextMessage(connection, data);
      },
      handleBinary: (data) => {
        void this.handleBinaryMessage(connection, data);
      },
      handleClose: (code, reason) => {
        void this.handleConnectionClose(connection, code, reason);
      },
      handleError: (error) => {
        void this.handleRuntimeError(connection, error, undefined);
      },
    };
  }

  async handleUpgrade(request: Request): Promise<UpgradeDecision> {
    if (!this.compiled.lifecycle.onUpgrade) {
      return {};
    }

    try {
      const result = await this.compiled.lifecycle.onUpgrade.handler(request);
      return {
        meta: result.meta,
        tags: result.tags,
      };
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        (error as { __wskit?: string }).__wskit === 'reject-upgrade'
      ) {
        return {
          reject: true,
          code: (error as { code: number }).code,
          reason: (error as { reason: string }).reason,
        };
      }

      return {
        reject: true,
        code: 500,
        reason: 'Upgrade failed',
      };
    }
  }

  async handleShutdown(): Promise<void> {
    if (this.compiled.lifecycle.onShutdown) {
      await this.compiled.lifecycle.onShutdown.handler(this.createShutdownContext());
    }

    for (const runtime of this.moduleRuntimes) {
      if (runtime.onShutdown) await runtime.onShutdown();
    }

    for (const connection of [...this.connections.values()]) {
      await this.cancelActiveStreamsForConnection(connection.id);
    }

    for (const connection of this.connections.values()) {
      connection.descriptor.close(CloseCodes.GOING_AWAY, 'Server shutting down');
    }

    if (this.alarmHandle !== null && this.timers) {
      this.timers.clearTimeout(this.alarmHandle);
      this.alarmHandle = null;
    }
  }

  async handleAlarm(): Promise<void> {
    const now = Date.now();
    const due = [...this.scheduledRuns.values()].filter((run) => run.time <= now);

    for (const run of due) {
      const task = this.compiled.scheduled.get(run.taskId);
      if (task?.handler) {
        await task.handler(this.createTaskContext(), run.data);
      }
      this.scheduledRuns.delete(run.id);

      if (run.every) {
        this.scheduledRuns.set(run.id, {
          ...run,
          time: now + run.every,
        });
      }
    }

    this.persistScheduledRuns();
    this.rescheduleAlarm();
  }

  private scheduleTask(taskId: string, time: number, data: unknown): void {
    const task = this.compiled.scheduled.get(taskId);
    const run: ScheduledRun = {
      id: this.generateId('task'),
      taskId,
      time,
      data,
      every: task?.options?.every,
    };

    this.scheduledRuns.set(run.id, run);
    this.persistScheduledRuns();
    this.rescheduleAlarm();
  }

  private cancelScheduled(taskId: string): void {
    for (const [id, run] of this.scheduledRuns) {
      if (run.taskId === taskId) {
        this.scheduledRuns.delete(id);
      }
    }
    this.persistScheduledRuns();
    this.rescheduleAlarm();
  }

  private rescheduleAlarm(): void {
    if (!this.timers) return;

    const nextRun = [...this.scheduledRuns.values()].sort((a, b) => a.time - b.time)[0];

    if (!nextRun) {
      if (this.alarmHandle !== null) {
        this.timers.clearTimeout(this.alarmHandle);
        this.alarmHandle = null;
      }
      return;
    }

    if (this.timers.setAlarm) {
      void this.timers.setAlarm(nextRun.time);
      return;
    }

    if (this.alarmHandle !== null) {
      this.timers.clearTimeout(this.alarmHandle);
    }

    this.alarmHandle = this.timers.setTimeout(
      () => {
        void this.handleAlarm();
      },
      Math.max(0, nextRun.time - Date.now()),
    );
  }

  private installHeartbeat(connection: RuntimeConnection): void {
    if (!this.compiled.heartbeatTimeout || !this.timers) return;
    if (connection.heartbeatTimer !== undefined) {
      this.timers.clearTimeout(connection.heartbeatTimer);
    }
    connection.heartbeatTimer = this.timers.setTimeout(() => {
      connection.descriptor.close(CloseCodes.IDLE, 'Heartbeat timeout');
    }, this.compiled.heartbeatTimeout);
  }

  private refreshHeartbeat(connection: RuntimeConnection): void {
    this.installHeartbeat(connection);
  }

  private async runConnectionLifecycle(
    kind: 'connect' | 'disconnect',
    ctx: Record<PropertyKey, unknown>,
  ): Promise<void> {
    this.activeConnectionId = String(ctx.id);

    if (kind === 'connect') {
      if (this.compiled.lifecycle.onConnect) {
        await this.compiled.lifecycle.onConnect.handler(ctx);
      }
      for (const runtime of this.moduleRuntimes) {
        if (runtime.onConnect)
          await runtime.onConnect(this.createModuleScopedContext(runtime.instance.id, ctx));
      }
    } else {
      if (this.compiled.lifecycle.onDisconnect) {
        await this.compiled.lifecycle.onDisconnect.handler(ctx);
      }
      for (const runtime of this.moduleRuntimes) {
        if (runtime.onDisconnect)
          await runtime.onDisconnect(this.createModuleScopedContext(runtime.instance.id, ctx));
      }
    }

    this.activeConnectionId = undefined;
  }

  private async handleConnectionClose(
    connection: RuntimeConnection,
    _code: number,
    _reason: string,
  ): Promise<void> {
    await this.cancelActiveStreamsForConnection(connection.id);

    const ctx = this.buildConnectionContext(connection);
    await this.runConnectionLifecycle('disconnect', ctx);

    for (const channelName of [...connection.channels]) {
      const resolved = this.compiled.channels.get(channelName);
      await this.leaveChannel(connection, {
        channel: resolved,
        channelName,
      });
    }

    if (connection.heartbeatTimer !== undefined && this.timers) {
      this.timers.clearTimeout(connection.heartbeatTimer);
    }

    this.connections.delete(connection.id);
    this.wsToConnectionId.delete(connection.wsKey);
  }

  private async cancelActiveStreamsForConnection(connectionId: string): Promise<void> {
    for (const activeStream of [...this.activeStreams.values()]) {
      if (activeStream.connectionId !== connectionId) continue;
      activeStream.closed = true;
      try {
        await activeStream.generator.return(undefined);
      } finally {
        this.activeStreams.delete(activeStream.id);
      }
    }
  }

  private async handleBinaryMessage(
    connection: RuntimeConnection,
    data: ArrayBuffer,
  ): Promise<void> {
    this.refreshHeartbeat(connection);
    if (!this.compiled.lifecycle.onBinary) return;
    const ctx = this.buildConnectionContext(connection);
    await this.compiled.lifecycle.onBinary.handler(ctx, data);
  }

  private async processTextMessage(connection: RuntimeConnection, data: string): Promise<void> {
    this.refreshHeartbeat(connection);

    let parsed: { event: string; payload?: unknown };

    try {
      parsed = JSON.parse(data) as { event: string; payload?: unknown };
    } catch {
      this.logger.warn('Invalid JSON message dropped');
      return;
    }

    if (parsed.event === 'ping') {
      connection.descriptor.send(JSON.stringify({ event: 'pong' }));
      return;
    }

    if (parsed.event === '_subscribe') {
      await this.handleSubscribe(connection, parsed.payload as Record<string, unknown> | undefined);
      return;
    }
    if (parsed.event === '_unsubscribe') {
      await this.handleUnsubscribe(
        connection,
        parsed.payload as Record<string, unknown> | undefined,
      );
      return;
    }
    if (parsed.event === '_replay') {
      await this.handleReplay(connection, parsed.payload as Record<string, unknown> | undefined);
      return;
    }
    if (parsed.event === '_streamCancel') {
      await this.handleStreamCancel(
        connection,
        parsed.payload as Record<string, unknown> | undefined,
      );
      return;
    }
    if (
      await this.handleStreamNudge(
        connection,
        parsed.event,
        parsed.payload as Record<string, unknown> | undefined,
      )
    ) {
      return;
    }

    await this.dispatchIncoming(connection, parsed.event, parsed.payload);
  }

  private resolveScope(payload: unknown): {
    namespace?: CompiledNamespace;
    channel?: CompiledChannel;
    channelName?: string;
    channelScope?: string;
  } {
    if (!payload || typeof payload !== 'object') return {};
    const record = payload as Record<string, unknown>;

    if (typeof record._namespace === 'string') {
      return {
        namespace: this.compiled.namespaces.get(record._namespace),
      };
    }

    if (typeof record._channel === 'string') {
      if (typeof record._channelScope === 'string') {
        return {
          channel: this.compiled.channelFamilies.get(record._channelScope),
          channelName: record._channel,
          channelScope: record._channelScope,
        };
      }

      return {
        channel: this.compiled.channels.get(record._channel),
        channelName: record._channel,
      };
    }

    return {};
  }

  private async dispatchIncoming(
    connection: RuntimeConnection,
    event: string,
    rawPayload: unknown,
    attempt = 0,
  ): Promise<void> {
    const scope = this.resolveScope(rawPayload);
    if (scope.channelName && !connection.channels.has(scope.channelName)) {
      return;
    }
    const scopedIncoming =
      scope.channel?.incoming.get(event) ?? scope.namespace?.incoming.get(event);
    const scopedRequest =
      scope.channel?.requests.get(event) ?? scope.namespace?.requests.get(event);
    const scopedStream = scope.channel?.streams.get(event) ?? scope.namespace?.streams.get(event);
    const incoming = scopedIncoming ?? this.compiled.incoming.get(event);
    const request = scopedRequest ?? this.compiled.requests.get(event);
    const stream = scopedStream ?? this.compiled.streams.get(event);

    let message = { event, payload: rawPayload };

    try {
      for (const runtime of this.moduleRuntimes) {
        if (!runtime.onIncoming) continue;
        const next = runtime.onIncoming(message);
        if (next) message = next;
      }

      for (const intercept of this.compiled.preIntercepts) {
        const ctx = this.buildConnectionContext(connection, scope);
        this.activeConnectionId = connection.id;
        const next = await intercept.handler(ctx, message);
        this.activeConnectionId = undefined;
        if (next) message = next;
      }

      if (scope.namespace) {
        for (const intercept of scope.namespace.preIntercepts) {
          const ctx = this.buildConnectionContext(connection, scope);
          this.activeConnectionId = connection.id;
          const next = await intercept.handler(ctx, message);
          this.activeConnectionId = undefined;
          if (next) message = next;
        }
      }
      if (scope.channel) {
        for (const intercept of scope.channel.preIntercepts) {
          const ctx = this.buildConnectionContext(connection, scope);
          this.activeConnectionId = connection.id;
          const next = await intercept.handler(ctx, message);
          this.activeConnectionId = undefined;
          if (next) message = next;
        }
      }

      const primitive = incoming ?? request ?? stream;
      if (!primitive) return;

      const payload = validateValue(
        'stream' in primitive ? primitive.stream.validator : primitive.validator,
        message.payload,
        event,
      );

      const topPost = this.compiled.postIntercepts.get(event) ?? [];
      const scopedPost =
        scope.channel?.postIntercepts.get(event) ??
        scope.namespace?.postIntercepts.get(event) ??
        [];
      let postPayload = payload;

      for (const intercept of [...topPost, ...scopedPost]) {
        const ctx = this.buildConnectionContext(connection, scope);
        this.activeConnectionId = connection.id;
        const next = await intercept.handler(ctx, postPayload);
        this.activeConnectionId = undefined;
        if (next !== undefined) postPayload = next;
      }

      connection.activeAckId =
        message.payload &&
        typeof message.payload === 'object' &&
        '_ackId' in (message.payload as object)
          ? String((message.payload as Record<string, unknown>)._ackId)
          : undefined;

      if (incoming) {
        const ctx = this.buildConnectionContext(connection, scope);
        this.activeConnectionId = connection.id;
        await incoming.handler(ctx, postPayload);
        this.activeConnectionId = undefined;
        return;
      }

      if (request) {
        const correlationId =
          message.payload &&
          typeof message.payload === 'object' &&
          '_correlationId' in (message.payload as object)
            ? String((message.payload as Record<string, unknown>)._correlationId)
            : undefined;
        const ctx = this.buildConnectionContext(connection, scope);
        this.activeConnectionId = connection.id;
        const response = await request.handler(ctx, postPayload);
        this.activeConnectionId = undefined;
        this.sendThroughPipeline(
          connection,
          {
            namespace: scope.namespace?.name,
            channel: scope.channelName,
            channelScope: scope.channelScope,
            correlationId,
          },
          event,
          response,
        );
        return;
      }

      if (stream) {
        const streamId = this.generateId('stream');
        this.sendProtocolMessage(connection, '_streamOk', { _streamId: streamId });
        const ctx = this.buildConnectionContext(connection, scope) as Record<string, unknown>;
        ctx.nudges = (value: unknown) => (Array.isArray(value) ? value : []);
        this.activeConnectionId = connection.id;
        const iterator = stream.generator(ctx, postPayload);
        this.activeConnectionId = undefined;
        const activeStream: ActiveStream = {
          id: streamId,
          connectionId: connection.id,
          generator: iterator as AsyncGenerator<unknown, void, unknown>,
          nudges: [],
          nudgeValidators: new Map(
            stream.stream.nudges.map((declaration) => [declaration.event, declaration.validator]),
          ),
          closed: false,
        };
        this.activeStreams.set(streamId, activeStream);

        try {
          let nextInput: unknown = stream.stream.nudges.length > 0 ? [] : undefined;

          while (!activeStream.closed) {
            const result = await iterator.next(nextInput);
            if (result.done) break;

            this.sendThroughPipeline(
              connection,
              {
                namespace: scope.namespace?.name,
                channel: scope.channelName,
                channelScope: scope.channelScope,
                streamId,
              },
              event,
              result.value,
            );

            nextInput = stream.stream.nudges.length > 0 ? [...activeStream.nudges] : undefined;
            activeStream.nudges.length = 0;
          }

          if (!activeStream.closed) {
            this.sendProtocolMessage(connection, '_streamEnd', { _streamId: streamId });
          }
        } catch (streamError) {
          await this.handleRuntimeError(connection, streamError, event, {
            _streamId: streamId,
            ...(scope.namespace?.name ? { _namespace: scope.namespace.name } : {}),
            ...(scope.channelName ? { _channel: scope.channelName } : {}),
            ...(scope.channelScope ? { _channelScope: scope.channelScope } : {}),
          });
        } finally {
          this.activeStreams.delete(streamId);
        }
      }
    } catch (error) {
      if (error === Block) return;
      if (error === Skip) return;
      if (
        error &&
        typeof error === 'object' &&
        (error as { __wskit?: string }).__wskit === 'disconnect'
      ) {
        connection.descriptor.close(
          (error as { code: number }).code,
          (error as { reason: string }).reason,
        );
        return;
      }
      if (
        error &&
        typeof error === 'object' &&
        (error as { __wskit?: string }).__wskit === 'defer'
      ) {
        if (attempt >= 3) {
          await this.handleRuntimeError(
            connection,
            DeferExhausted({ event, payload: rawPayload, retries: attempt + 1 }),
            event,
          );
          return;
        }

        const delay = Number((error as { delay: number }).delay);
        this.requireTimers().setTimeout(() => {
          void this.dispatchIncoming(connection, event, rawPayload, attempt + 1);
        }, delay);
        return;
      }
      await this.handleRuntimeError(connection, error, event);
    }
  }

  private sendThroughPipeline(
    connection: RuntimeConnection,
    routing:
      | {
          namespace?: string;
          channel?: string;
          channelScope?: string;
          correlationId?: string;
          streamId?: string;
        }
      | undefined,
    event: string,
    payload: unknown,
  ): boolean {
    let message = { event, payload };

    for (const runtime of this.moduleRuntimes) {
      if (!runtime.onOutgoing) continue;
      const next = runtime.onOutgoing(message);
      if (next) message = next;
    }

    const finalPayload: Record<string, unknown> =
      message.payload && typeof message.payload === 'object'
        ? { ...(message.payload as Record<string, unknown>) }
        : { value: message.payload };

    for (const key of Object.keys(finalPayload)) {
      if (key.startsWith('_')) {
        throw new Error(
          `[wskit] Outgoing payload fields starting with "_" are reserved for the engine.`,
        );
      }
    }

    if (!this.isDeclaredOutgoingEvent(message.event, routing)) {
      throw new Error(
        `[wskit] Outgoing event "${message.event}" was not declared in the active scope.`,
      );
    }

    if (this.compiled.sequence && !message.event.startsWith('_')) {
      this.seqCounter += 1;
      finalPayload._seq = this.seqCounter;
    }
    if (this.compiled.dedup && !message.event.startsWith('_')) {
      finalPayload._messageId = this.generateId('msg');
    }
    if (routing?.namespace) finalPayload._namespace = routing.namespace;
    if (routing?.channel) finalPayload._channel = routing.channel;
    if (routing?.channelScope) finalPayload._channelScope = routing.channelScope;
    if (routing?.correlationId) finalPayload._correlationId = routing.correlationId;
    if (routing?.streamId) finalPayload._streamId = routing.streamId;

    connection.descriptor.send(JSON.stringify({ event: message.event, payload: finalPayload }));
    return true;
  }

  private broadcastToConnections(
    connections: readonly RuntimeConnection[],
    event: string,
    payload: unknown,
    options?: BroadcastOptions & { namespace?: string },
    excludeConnectionId?: string,
  ): void {
    for (const connection of connections) {
      if (options?.excludeSelf && connection.id === excludeConnectionId) continue;
      this.sendThroughPipeline(
        connection,
        {
          namespace: (options as { namespace?: string } | undefined)?.namespace,
          channel: options?.channel,
        },
        event,
        payload,
      );
    }
  }

  private broadcastToChannel(
    channelName: string,
    event: string,
    payload: unknown,
    excludeConnectionId?: string,
    channelScope?: string,
  ): void {
    const connections = [...this.connections.values()].filter((connection) =>
      connection.channels.has(channelName),
    );

    for (const connection of connections) {
      if (excludeConnectionId && connection.id === excludeConnectionId) continue;
      this.sendThroughPipeline(connection, { channel: channelName, channelScope }, event, payload);
    }
  }

  private getChannelMembers(channelName: string): ConnectionInfo<Record<string, unknown>>[] {
    return [...this.connections.values()]
      .filter((connection) => connection.channels.has(channelName))
      .map((connection) => this.toConnectionInfo(connection));
  }

  private kickChannelMembers(channelName: string, tag: string, reason: string): void {
    for (const connection of this.connections.values()) {
      if (!connection.channels.has(channelName) || !connection.tags.has(tag)) continue;
      const resolved = this.compiled.channels.get(channelName);
      void this.leaveChannel(connection, { channel: resolved, channelName }, reason);
    }
  }

  private async leaveChannel(
    connection: RuntimeConnection,
    scope: { channel?: CompiledChannel; channelName: string; channelScope?: string },
    kickedReason?: string,
  ): Promise<void> {
    if (!connection.channels.has(scope.channelName)) return;

    const ctx = this.buildConnectionContext(connection, scope);

    if (scope.channel?.onUnsubscribe) {
      await scope.channel.onUnsubscribe.handler(ctx);
    }

    connection.channels.delete(scope.channelName);
    connection.tags.delete(`channel:${scope.channelName}`);
    this.persistAttachment(connection);

    if (kickedReason) {
      this.sendProtocolMessage(connection, '_kicked', {
        _channel: scope.channelName,
        ...(scope.channelScope ? { _channelScope: scope.channelScope } : {}),
        reason: kickedReason,
      });
    }

    this.broadcastToChannel(
      scope.channelName,
      '_memberLeave',
      { connectionId: connection.id },
      connection.id,
      scope.channelScope,
    );
  }

  private async handleSubscribe(
    connection: RuntimeConnection,
    payload: Record<string, unknown> | undefined,
  ): Promise<void> {
    if (!payload || typeof payload._channel !== 'string') return;

    const resolved =
      typeof payload._channelScope === 'string'
        ? this.compiled.channelFamilies.get(payload._channelScope)
        : this.compiled.channels.get(payload._channel);
    if (!resolved) return;

    const existingMembers = this.getChannelMembers(payload._channel);
    const scope = {
      channel: resolved,
      channelName: payload._channel,
      channelScope: typeof payload._channelScope === 'string' ? payload._channelScope : undefined,
    };
    const ctx = this.buildConnectionContext(connection, scope);

    if (resolved.onBeforeSubscribe) {
      const data = { ...payload };
      delete data._channel;
      delete data._channelScope;
      await resolved.onBeforeSubscribe.handler(
        ctx,
        resolved.onBeforeSubscribe.validator
          ? validateValue(resolved.onBeforeSubscribe.validator, data, '_subscribe')
          : data,
      );
    }

    connection.channels.add(payload._channel);
    connection.tags.add(`channel:${payload._channel}`);
    this.persistAttachment(connection);

    if (resolved.onSubscribe) {
      await resolved.onSubscribe.handler(ctx);
    }

    this.sendProtocolMessage(connection, '_subscribeOk', {
      _channel: payload._channel,
      ...(scope.channelScope ? { _channelScope: scope.channelScope } : {}),
    });

    for (const member of existingMembers) {
      this.sendProtocolMessage(connection, '_memberJoin', {
        _channel: payload._channel,
        ...(scope.channelScope ? { _channelScope: scope.channelScope } : {}),
        connectionId: member.id,
        meta: member.meta,
      });
    }

    this.broadcastToChannel(
      payload._channel,
      '_memberJoin',
      {
        connectionId: connection.id,
        meta: connection.meta,
      },
      connection.id,
      scope.channelScope,
    );
  }

  private async handleUnsubscribe(
    connection: RuntimeConnection,
    payload: Record<string, unknown> | undefined,
  ): Promise<void> {
    if (!payload || typeof payload._channel !== 'string') return;
    const resolved =
      typeof payload._channelScope === 'string'
        ? this.compiled.channelFamilies.get(payload._channelScope)
        : this.compiled.channels.get(payload._channel);
    if (!resolved) return;

    const scope = {
      channel: resolved,
      channelName: payload._channel,
      channelScope: typeof payload._channelScope === 'string' ? payload._channelScope : undefined,
    };
    await this.leaveChannel(connection, scope);
  }

  private async handleReplay(
    connection: RuntimeConnection,
    payload: Record<string, unknown> | undefined,
  ): Promise<void> {
    const since = Number(payload?.since ?? 0);
    const scope = this.resolveScope(payload);
    const replay = scope.channel?.replay ?? this.compiled.replay;
    if (!replay?.onReplay) return;
    const ctx = this.buildConnectionContext(connection, scope);
    await replay.onReplay(ctx, since);
  }

  private async handleStreamCancel(
    connection: RuntimeConnection,
    payload: Record<string, unknown> | undefined,
  ): Promise<void> {
    if (!payload || typeof payload._streamId !== 'string') return;
    const activeStream = this.activeStreams.get(payload._streamId);
    if (!activeStream || activeStream.connectionId !== connection.id || activeStream.closed) {
      return;
    }

    activeStream.closed = true;
    try {
      await activeStream.generator.return(undefined);
    } finally {
      this.activeStreams.delete(activeStream.id);
    }
  }

  private async handleStreamNudge(
    connection: RuntimeConnection,
    event: string,
    payload: Record<string, unknown> | undefined,
  ): Promise<boolean> {
    if (!payload || typeof payload._streamId !== 'string') return false;
    const activeStream = this.activeStreams.get(payload._streamId);
    if (!activeStream || activeStream.connectionId !== connection.id || activeStream.closed) {
      return false;
    }

    const validator = activeStream.nudgeValidators.get(event);
    if (!activeStream.nudgeValidators.has(event)) return false;

    const nudgePayload = { ...payload };
    delete nudgePayload._streamId;

    activeStream.nudges.push({
      event,
      payload: validateValue(validator, nudgePayload, event),
    });
    return true;
  }

  private async handleRuntimeError(
    connection: RuntimeConnection,
    error: unknown,
    event?: string,
    routing?: Record<string, unknown>,
  ): Promise<void> {
    if (this.compiled.lifecycle.onError) {
      const ctx = this.buildConnectionContext(connection);
      const shouldSend = await this.compiled.lifecycle.onError.handler(ctx, error, event);
      if (shouldSend === false) return;
    }

    const payload =
      error instanceof WskitError
        ? { code: error.code, detail: error.detail, ...routing }
        : { code: 'internal-error', ...routing };
    this.sendProtocolMessage(connection, '_error', payload);
  }
}
