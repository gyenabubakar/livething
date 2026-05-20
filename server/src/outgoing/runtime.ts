/* oxlint-disable @typescript-eslint/no-explicit-any */
import * as Protocol from '~/_engine/runtime/protocol.ts';
import * as ChannelPrimitive from '~/channel/runtime.ts';
import type * as EngineCompileTypes from '~/_engine/compile/types.ts';
import type * as EngineRuntimeTypes from '~/_engine/runtime/types.ts';
import type * as PublicApi from '~/context.ts';

type CompiledServer = EngineCompileTypes.CompiledServer;

/**
 * Minimal dependency bag for outgoing message helpers.
 */
export interface OutgoingRuntime {
  compiled: EngineCompileTypes.CompiledServer;
  moduleRuntimes: readonly EngineRuntimeTypes.ModuleRuntime[];
  outgoingHooks: readonly ((message: { event: string; payload: unknown }) => unknown | void)[];
  /**
   * Contributors of `__wskit` metadata for outgoing user frames — the sequence
   * number and the dedup id. Skipped for protocol frames.
   */
  wskitStampHooks: readonly ((event: string) => Record<string, unknown>)[];
  beforeSendHooks: readonly ((message: EngineRuntimeTypes.WireOutgoingMessage) => void)[];
  afterSendHooks: readonly ((
    message: EngineRuntimeTypes.WireOutgoingMessage,
  ) => void | Promise<void>)[];
  waitUntil(promise: Promise<unknown>): void;
  logger: {
    warn(message: string, data?: unknown): void;
    error(message: string, data?: unknown): void;
  };
  generateId(prefix?: string): string;
}

// ───── Section: declaration checks ─────

/** Check whether an event name belongs to any installed module's outgoing declarations. */
function isDeclaredModuleEvent(compiled: CompiledServer, event: string): boolean {
  for (const moduleInstance of compiled.modules) {
    for (const eventName of Object.keys(moduleInstance.outgoing)) {
      if (`__${moduleInstance.id}:${eventName}` === event) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Check whether an outgoing event was declared in the correct scope.
 *
 * Protocol frames (`__x__`) are engine traffic and always allowed — the engine
 * fans out `__memberJoin__` and the rest through this pipeline. Module events
 * (`__moduleId:event`) are checked against module declarations. Everything else
 * must appear in the scope's outgoing or stream maps.
 */
export function isDeclaredOutgoingEvent(
  compiled: EngineCompileTypes.CompiledServer,
  event: string,
  routing?: EngineRuntimeTypes.RoutingTarget,
): boolean {
  if (Protocol.isProtocolEventName(event)) return true;
  if (event.startsWith('__')) return isDeclaredModuleEvent(compiled, event);

  if (routing?.namespace) {
    const namespace = compiled.namespaces.get(routing.namespace);
    return (
      (namespace?.outgoing.has(event) ?? false) ||
      (namespace?.streams.has(event) ?? false) ||
      (namespace?.resumableStreams.has(event) ?? false) ||
      (namespace?.recordedStreams.has(event) ?? false)
    );
  }

  if (routing?.channel) {
    const channel =
      routing.channelScope === null || routing.channelScope === undefined
        ? compiled.channels.get(routing.channel)
        : compiled.channelFamilies.get(routing.channelScope);
    return (
      (channel?.outgoing.has(event) ?? false) ||
      (channel?.streams.has(event) ?? false) ||
      (channel?.resumableStreams.has(event) ?? false) ||
      (channel?.recordedStreams.has(event) ?? false)
    );
  }

  return (
    compiled.outgoing.has(event) ||
    compiled.streams.has(event) ||
    compiled.resumableStreams.has(event) ||
    compiled.recordedStreams.has(event)
  );
}

// ───── Section: payload shape check ─────

/** Throw if the payload is not a plain object — arrays and primitives are rejected. */
export function assertPayloadRecord(payload: unknown): asserts payload is Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('[wskit] Outgoing payload must be a plain object.');
  }
}

// ───── Section: outgoing hook pipeline ─────

/** Run global + module `onOutgoing` hooks and return the (possibly rewritten) message. */
function runOutgoingHooks(
  outgoingHooks: OutgoingRuntime['outgoingHooks'],
  moduleRuntimes: readonly EngineRuntimeTypes.ModuleRuntime[],
  message: { event: string; payload: unknown },
): { event: string; payload: unknown } {
  let current = message;

  // Hook return value replaces the payload only — the event is already bound.
  for (const hook of outgoingHooks) {
    const next = hook(current);
    if (next !== undefined) current = { event: current.event, payload: next };
  }

  assertPayloadRecord(current.payload);

  for (const moduleRuntime of moduleRuntimes) {
    if (!moduleRuntime.onOutgoing) continue;
    const next = moduleRuntime.onOutgoing(current);
    if (next !== undefined) current = { event: current.event, payload: next };
  }

  assertPayloadRecord(current.payload);
  return current;
}

/** Build the `__wskit` block for an outgoing frame from its routing target. */
function buildWskit(
  routing: EngineRuntimeTypes.RoutingTarget | undefined,
): Record<string, unknown> {
  const wskit: Record<string, unknown> = {};
  if (routing?.namespace) wskit.namespace = routing.namespace;
  if (routing?.channel) wskit.channel = routing.channel;
  if (routing?.channelScope !== null && routing?.channelScope !== undefined) {
    wskit.channelScope = routing.channelScope;
  }
  if (routing?.correlationId) wskit.correlationId = routing.correlationId;
  if (routing?.streamId) wskit.streamId = routing.streamId;
  if (typeof routing?.seq === 'number') wskit.seq = routing.seq;
  return wskit;
}

/**
 * Run the sequence/dedup stampers and merge their output into `__wskit`. A
 * value already set from routing wins — a durable stream's own `seq` is not
 * overwritten by the global sequence counter.
 */
function applyWskitStampers(
  stampers: OutgoingRuntime['wskitStampHooks'],
  event: string,
  wskit: Record<string, unknown>,
): void {
  if (Protocol.isProtocolEventName(event)) return;
  for (const stamp of stampers) {
    const stamped = stamp(event);
    for (const [key, value] of Object.entries(stamped)) {
      if (wskit[key] === undefined) wskit[key] = value;
    }
  }
}

/** Fan out after-send hooks, forwarding async rejections through the engine's waitUntil + logger. */
function invokeAfterSendHooks(
  afterSendHooks: OutgoingRuntime['afterSendHooks'],
  waitUntil: OutgoingRuntime['waitUntil'],
  logger: OutgoingRuntime['logger'],
  wireMessage: EngineRuntimeTypes.WireOutgoingMessage,
): void {
  for (const hook of afterSendHooks) {
    try {
      const result = hook(wireMessage);

      if (result && typeof (result as Promise<unknown>).then === 'function') {
        waitUntil(
          Promise.resolve(result).catch((error) => {
            logger.error('[wskit] after-send hook failed', { error });
          }),
        );
      }
    } catch (error) {
      logger.error('[wskit] after-send hook failed', { error });
    }
  }
}

// ───── Section: wire send primitives ─────

/**
 * Push one outgoing event through module hooks, declaration checks, and
 * `__wskit` metadata before sending it to a connection.
 */
export function sendThroughPipeline(
  runtime: OutgoingRuntime,
  connection: EngineRuntimeTypes.RuntimeConnection,
  routing: EngineRuntimeTypes.RoutingTarget | undefined,
  event: string,
  payload: unknown,
): boolean {
  assertPayloadRecord(payload);

  const message = runOutgoingHooks(runtime.outgoingHooks, runtime.moduleRuntimes, {
    event,
    payload,
  });

  const isRequestResponse = !!routing?.correlationId;
  if (!isRequestResponse && !isDeclaredOutgoingEvent(runtime.compiled, message.event, routing)) {
    throw new Error(
      `[wskit] Outgoing event "${message.event}" was not declared in the active scope.`,
    );
  }

  const wskit = buildWskit(routing);
  applyWskitStampers(runtime.wskitStampHooks, message.event, wskit);

  const finalPayload = message.payload as Record<string, unknown>;

  const wireMessage: EngineRuntimeTypes.WireOutgoingMessage = {
    connectionId: connection.id,
    event: message.event,
    payload: finalPayload,
    wskit,
    meta: connection.meta,
  };

  for (const hook of runtime.beforeSendHooks) {
    hook(wireMessage);
  }

  connection.descriptor.send(
    JSON.stringify({ event: message.event, payload: finalPayload, __wskit: wskit }),
  );

  invokeAfterSendHooks(runtime.afterSendHooks, runtime.waitUntil, runtime.logger, wireMessage);

  return true;
}

/**
 * Broadcast one event to a set of already-selected connections.
 */
export function broadcastToConnections(
  runtime: Pick<
    OutgoingRuntime,
    | 'afterSendHooks'
    | 'beforeSendHooks'
    | 'compiled'
    | 'generateId'
    | 'logger'
    | 'moduleRuntimes'
    | 'outgoingHooks'
    | 'waitUntil'
    | 'wskitStampHooks'
  >,
  connections: readonly EngineRuntimeTypes.RuntimeConnection[],
  event: string,
  payload: unknown,
  options?: PublicApi.BroadcastOptions & {
    namespace?: string;
    channel?: string;
    channelScope?: string | null;
  },
  excludeConnectionId?: string,
): void {
  for (const connection of connections) {
    if (
      excludeConnectionId &&
      (options?.excludeSelf ?? true) &&
      connection.id === excludeConnectionId
    )
      continue;
    // One bad peer must not silently swallow the rest of the broadcast.
    // descriptor.send throws InvalidStateError when the socket is in
    // CLOSING before the engine has processed webSocketClose, and
    // JSON.stringify throws on non-serializable payload fields. Either
    // throw used to break the for loop and skip every later peer; log
    // and continue so every healthy peer still receives the frame.
    try {
      sendThroughPipeline(
        runtime,
        connection,
        {
          namespace: options?.namespace,
          channel: options?.channel,
          channelScope: options?.channelScope,
        },
        event,
        payload,
      );
    } catch (error) {
      runtime.logger?.error('[wskit] broadcast send to one peer threw; continuing fanout', {
        connectionId: connection.id,
        event,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * Broadcast one event to every member currently in a channel.
 */
export function broadcastToChannel(
  runtime: EngineRuntimeTypes.ConnectionMembersRuntime &
    Pick<
      OutgoingRuntime,
      | 'afterSendHooks'
      | 'beforeSendHooks'
      | 'compiled'
      | 'generateId'
      | 'logger'
      | 'moduleRuntimes'
      | 'outgoingHooks'
      | 'waitUntil'
      | 'wskitStampHooks'
    >,
  channelName: string,
  event: string,
  payload: unknown,
  excludeConnectionId: string | undefined,
  channelScope: string | null,
  excludeSelf?: boolean,
): void {
  const connections = [...runtime.connections.values()].filter((connection) => {
    return ChannelPrimitive.hasChannelMembership(connection, channelName, channelScope);
  });

  for (const connection of connections) {
    if (excludeConnectionId && (excludeSelf ?? true) && connection.id === excludeConnectionId)
      continue;
    // Same reasoning as broadcastToConnections: one peer's send failure
    // must not silently drop the rest of the channel's fanout.
    try {
      sendThroughPipeline(
        runtime,
        connection,
        { channel: channelName, channelScope },
        event,
        payload,
      );
    } catch (error) {
      runtime.logger?.error('[wskit] channel broadcast send to one peer threw; continuing fanout', {
        connectionId: connection.id,
        channel: channelName,
        channelScope,
        event,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
