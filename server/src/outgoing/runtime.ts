/* oxlint-disable @typescript-eslint/no-explicit-any */
import * as EngineCompileUtils from '~/_engine/compile/utils.ts';
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
      if (EngineCompileUtils.prefixedModuleEvent(moduleInstance.id, eventName) === event) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Check whether an outgoing event was declared in the correct scope.
 *
 * Module events (`__`-prefixed) are checked against module declarations.
 * Single-underscore names are reserved for engine protocol traffic — only
 * the engine-known protocol names pass this check; any other `_`-prefixed
 * name fails so future protocol additions stay non-breaking. Everything
 * else must appear in the scope's outgoing or stream maps.
 */
export function isDeclaredOutgoingEvent(
  compiled: EngineCompileTypes.CompiledServer,
  event: string,
  routing?: EngineRuntimeTypes.RoutingTarget,
): boolean {
  if (event.startsWith('__')) return isDeclaredModuleEvent(compiled, event);
  if (event.startsWith('_')) return EngineCompileUtils.isEngineOutgoingProtocolEvent(event);

  if (routing?.namespace) {
    const namespace = compiled.namespaces.get(routing.namespace);
    return (namespace?.outgoing.has(event) ?? false) || (namespace?.streams.has(event) ?? false);
  }

  if (routing?.channel) {
    const channel =
      routing.channelScope === null || routing.channelScope === undefined
        ? compiled.channels.get(routing.channel)
        : compiled.channelFamilies.get(routing.channelScope);
    return (channel?.outgoing.has(event) ?? false) || (channel?.streams.has(event) ?? false);
  }

  return compiled.outgoing.has(event) || compiled.streams.has(event);
}

// ───── Section: payload shape + reserved-key checks ─────

/** Throw if the payload is not a plain object — arrays and primitives are rejected. */
export function assertPayloadRecord(payload: unknown): asserts payload is Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('[wskit] Outgoing payload must be a plain object.');
  }
}

/** Throw if any payload key starts with `_` — those are reserved for the engine. */
export function assertNoReservedPayloadFields(payload: Record<string, unknown>): void {
  for (const key of Object.keys(payload)) {
    if (key.startsWith('_')) {
      throw new Error(
        '[wskit] Outgoing payload fields starting with "_" are reserved for the engine.',
      );
    }
  }
}

/**
 * Throw if any `_`-prefixed field on the payload differs from the snapshot
 * captured before module hooks ran — added, removed, or value-changed.
 * Engine `onOutgoing` hooks (sequence, dedup) write reserved fields like
 * `_seq` and `_messageId` first; the snapshot is taken right after, then
 * module hooks run. This check rejects any module attempt to mutate engine
 * wire metadata, not just additions.
 */
function assertReservedPayloadFieldsUnchanged(
  payload: Record<string, unknown>,
  reservedSnapshot: ReadonlyMap<string, unknown>,
): void {
  for (const key of Object.keys(payload)) {
    if (!key.startsWith('_')) continue;
    if (!reservedSnapshot.has(key) || !Object.is(payload[key], reservedSnapshot.get(key))) {
      throw new Error(
        '[wskit] Outgoing payload fields starting with "_" are reserved for the engine.',
      );
    }
  }
  for (const key of reservedSnapshot.keys()) {
    if (!(key in payload)) {
      throw new Error(
        '[wskit] Outgoing payload fields starting with "_" are reserved for the engine.',
      );
    }
  }
}

// ───── Section: outgoing hook pipeline ─────

/** Run global + module `onOutgoing` hooks and return the (possibly rewritten) message. */
function runOutgoingHooks(
  outgoingHooks: OutgoingRuntime['outgoingHooks'],
  moduleRuntimes: readonly EngineRuntimeTypes.ModuleRuntime[],
  message: { event: string; payload: unknown },
): { message: { event: string; payload: unknown }; allowedReservedFields: ReadonlySet<string> } {
  let current = message;

  // Hook return value replaces the payload only — the event is already
  // bound. A hook returning `{ event, payload }` puts the whole object in
  // `current.payload`; routing fields on the object have no special meaning.
  for (const hook of outgoingHooks) {
    const next = hook(current);
    if (next !== undefined) current = { event: current.event, payload: next };
  }

  assertPayloadRecord(current.payload);
  const reservedSnapshot = new Map<string, unknown>();
  for (const [key, value] of Object.entries(current.payload)) {
    if (key.startsWith('_')) reservedSnapshot.set(key, value);
  }

  for (const moduleRuntime of moduleRuntimes) {
    if (!moduleRuntime.onOutgoing) continue;
    const next = moduleRuntime.onOutgoing(current);
    if (next !== undefined) current = { event: current.event, payload: next };
  }

  assertPayloadRecord(current.payload);
  assertReservedPayloadFieldsUnchanged(current.payload, reservedSnapshot);

  return { message: current, allowedReservedFields: new Set(reservedSnapshot.keys()) };
}

/** Attach reserved routing markers (`_namespace`, `_channel`, etc.) onto an outgoing payload. */
function injectRoutingMarkers(
  payload: Record<string, unknown>,
  routing: EngineRuntimeTypes.RoutingTarget | undefined,
): Record<string, unknown> {
  const finalPayload: Record<string, unknown> = { ...payload };
  if (routing?.namespace) finalPayload._namespace = routing.namespace;
  if (routing?.channel) finalPayload._channel = routing.channel;
  if (routing?.channelScope !== null && routing?.channelScope !== undefined) {
    finalPayload._channelScope = routing.channelScope;
  }
  if (routing?.correlationId) finalPayload._correlationId = routing.correlationId;
  if (routing?.streamId) finalPayload._streamId = routing.streamId;
  if (typeof routing?.seq === 'number') finalPayload._seq = routing.seq;
  return finalPayload;
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
 * Push one outgoing event through module hooks, declaration checks, and wire
 * metadata injection before sending it to a connection.
 */
export function sendThroughPipeline(
  runtime: OutgoingRuntime,
  connection: EngineRuntimeTypes.RuntimeConnection,
  routing: EngineRuntimeTypes.RoutingTarget | undefined,
  event: string,
  payload: unknown,
): boolean {
  assertPayloadRecord(payload);
  assertNoReservedPayloadFields(payload);

  const { message } = runOutgoingHooks(runtime.outgoingHooks, runtime.moduleRuntimes, {
    event,
    payload,
  });

  const isRequestResponse = !!routing?.correlationId;
  if (!isRequestResponse && !isDeclaredOutgoingEvent(runtime.compiled, message.event, routing)) {
    throw new Error(
      `[wskit] Outgoing event "${message.event}" was not declared in the active scope.`,
    );
  }

  const finalPayload = injectRoutingMarkers(message.payload as Record<string, unknown>, routing);

  const wireMessage: EngineRuntimeTypes.WireOutgoingMessage = {
    connectionId: connection.id,
    event: message.event,
    payload: finalPayload,
    meta: connection.meta,
  };

  for (const hook of runtime.beforeSendHooks) {
    hook(wireMessage);
  }

  connection.descriptor.send(JSON.stringify({ event: message.event, payload: finalPayload }));

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
