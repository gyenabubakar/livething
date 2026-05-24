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
  pluginRuntimes: readonly EngineRuntimeTypes.PluginRuntime[];
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
  logger: Pick<PublicApi.Logger, 'warn' | 'error'>;
  generateId(prefix?: string): string;
}

// ───── Section: declaration checks ─────

/** Check whether an event name belongs to any installed plugin's outgoing declarations. */
function isDeclaredPluginEvent(compiled: CompiledServer, event: string): boolean {
  for (const pluginInstance of compiled.plugins) {
    for (const eventName of Object.keys(pluginInstance.outgoing)) {
      if (`__${pluginInstance.id}:${eventName}` === event) {
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
 * fans out `__memberJoin__` and the rest through this pipeline. Plugin events
 * (`__pluginId:event`) are checked against plugin declarations. Everything else
 * must appear in the scope's outgoing or stream maps.
 */
export function isDeclaredOutgoingEvent(
  compiled: EngineCompileTypes.CompiledServer,
  event: string,
  routing?: EngineRuntimeTypes.RoutingTarget,
): boolean {
  if (Protocol.isProtocolEventName(event)) return true;
  if (event.startsWith('__')) return isDeclaredPluginEvent(compiled, event);

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

/** Run global + plugin `onOutgoing` hooks and return the (possibly rewritten) message. */
function runOutgoingHooks(
  outgoingHooks: OutgoingRuntime['outgoingHooks'],
  pluginRuntimes: readonly EngineRuntimeTypes.PluginRuntime[],
  message: { event: string; payload: unknown },
): { event: string; payload: unknown } {
  let current = message;

  // A hook return value replaces the payload only, never the event.
  for (const hook of outgoingHooks) {
    const next = hook(current);
    if (next !== undefined) current = { event: current.event, payload: next };
  }

  assertPayloadRecord(current.payload);

  for (const pluginRuntime of pluginRuntimes) {
    if (!pluginRuntime.onOutgoing) continue;
    const next = pluginRuntime.onOutgoing(current);
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
 * value already set from routing wins, so a durable stream's own `seq` stays.
 */
function applyWskitStampers(
  stampers: OutgoingRuntime['wskitStampHooks'],
  event: string,
  wskit: Record<string, unknown>,
): void {
  if (Protocol.isProtocolEventName(event)) return;
  for (const stamp of stampers) {
    const stamped = stamp(event);
    for (const key in stamped) {
      if (wskit[key] === undefined) wskit[key] = stamped[key];
    }
  }
}

/** Fan out after-send hooks, forwarding async rejections through the engine's waitUntil + logger. */
function invokeAfterSendHooks(
  runtime: Pick<OutgoingRuntime, 'afterSendHooks' | 'waitUntil' | 'logger'>,
  wireMessage: EngineRuntimeTypes.WireOutgoingMessage,
): void {
  const { afterSendHooks, waitUntil, logger } = runtime;
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
 * Push one outgoing event through plugin hooks, declaration checks, and
 * `__wskit` metadata before sending it to a connection.
 */
export interface SendThroughPipelineOptions {
  routing: EngineRuntimeTypes.RoutingTarget | undefined;
  event: string;
  payload: unknown;
}

export function sendThroughPipeline(
  runtime: OutgoingRuntime,
  connection: EngineRuntimeTypes.RuntimeConnection,
  opts: SendThroughPipelineOptions,
): boolean {
  const { routing, event, payload } = opts;
  assertPayloadRecord(payload);

  const message = runOutgoingHooks(runtime.outgoingHooks, runtime.pluginRuntimes, {
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

  invokeAfterSendHooks(runtime, wireMessage);

  return true;
}

// ───── Section: broadcast fan-out ─────

interface PreparedBroadcast {
  event: string;
  eventJson: string;
  payloadJson: string;
  finalPayload: Record<string, unknown>;
  baseWskit: Record<string, unknown>;
  needsWireMessage: boolean;
  /**
   * The whole frame string when it is identical for every recipient — set
   * when nothing stamps a per-connection `__wskit` value. Built once here so
   * `sendPrepared` skips the per-recipient stamp + serialize.
   */
  sharedFrame?: string;
}

type BroadcastRuntime = Pick<
  OutgoingRuntime,
  | 'afterSendHooks'
  | 'beforeSendHooks'
  | 'compiled'
  | 'logger'
  | 'pluginRuntimes'
  | 'outgoingHooks'
  | 'waitUntil'
  | 'wskitStampHooks'
>;

/**
 * Run the recipient-independent half of the send pipeline once for a whole
 * broadcast: outgoing hooks, the declaration check, the base `__wskit` block,
 * and JSON serialization of the event name and payload. `sendPrepared` reuses
 * the result for every recipient instead of repeating this per peer.
 */
interface PrepareBroadcastOptions {
  routing: EngineRuntimeTypes.RoutingTarget | undefined;
  event: string;
  payload: unknown;
}

function prepareBroadcast(
  runtime: BroadcastRuntime,
  opts: PrepareBroadcastOptions,
): PreparedBroadcast {
  const { routing, event, payload } = opts;
  assertPayloadRecord(payload);

  const message = runOutgoingHooks(runtime.outgoingHooks, runtime.pluginRuntimes, {
    event,
    payload,
  });

  if (!isDeclaredOutgoingEvent(runtime.compiled, message.event, routing)) {
    throw new Error(
      `[wskit] Outgoing event "${message.event}" was not declared in the active scope.`,
    );
  }

  const finalPayload = message.payload as Record<string, unknown>;
  const eventJson = JSON.stringify(message.event);
  const payloadJson = JSON.stringify(finalPayload);
  const baseWskit = buildWskit(routing);
  const hasBeforeSend = runtime.beforeSendHooks.length > 0;

  // The frame is identical for every recipient unless something stamps a
  // per-connection `__wskit` value. Stampers are skipped for protocol events,
  // so those always qualify; user events qualify only with no stampers. A
  // beforeSend hook can rewrite `__wskit` per recipient, so it disqualifies.
  const sharedWskit =
    !hasBeforeSend &&
    (Protocol.isProtocolEventName(message.event) || runtime.wskitStampHooks.length === 0);

  return {
    event: message.event,
    eventJson,
    payloadJson,
    finalPayload,
    baseWskit,
    needsWireMessage: hasBeforeSend || runtime.afterSendHooks.length > 0,
    sharedFrame: sharedWskit
      ? `{"event":${eventJson},"payload":${payloadJson},"__wskit":${JSON.stringify(baseWskit)}}`
      : undefined,
  };
}

/**
 * Send one prepared broadcast frame to a single recipient. Only per-connection
 * work runs here — `__wskit` stamping, before/after-send hooks, the wire write.
 * The frame splices in the prepared payload JSON, so the payload is never
 * re-serialized per recipient.
 */
function sendPrepared(
  runtime: BroadcastRuntime,
  connection: EngineRuntimeTypes.RuntimeConnection,
  prepared: PreparedBroadcast,
): void {
  // Shared-frame fast path: the bytes are the same for everyone, so just
  // write the prepared string. beforeSend is empty here (it disqualifies a
  // shared frame), so only an afterSend hook still needs the wire message.
  if (prepared.sharedFrame !== undefined) {
    connection.descriptor.send(prepared.sharedFrame);
    if (prepared.needsWireMessage) {
      invokeAfterSendHooks(runtime, {
        connectionId: connection.id,
        event: prepared.event,
        payload: prepared.finalPayload,
        wskit: prepared.baseWskit,
        meta: connection.meta,
      });
    }
    return;
  }

  const wskit = { ...prepared.baseWskit };
  applyWskitStampers(runtime.wskitStampHooks, prepared.event, wskit);

  // The wire message only feeds before/after-send hooks — skip the
  // per-recipient allocation when no such hooks are registered.
  let wireMessage: EngineRuntimeTypes.WireOutgoingMessage | undefined;
  if (prepared.needsWireMessage) {
    wireMessage = {
      connectionId: connection.id,
      event: prepared.event,
      payload: prepared.finalPayload,
      wskit,
      meta: connection.meta,
    };
    for (const hook of runtime.beforeSendHooks) {
      hook(wireMessage);
    }
  }

  connection.descriptor.send(
    `{"event":${prepared.eventJson},"payload":${prepared.payloadJson},"__wskit":${JSON.stringify(wskit)}}`,
  );

  if (wireMessage) {
    invokeAfterSendHooks(runtime, wireMessage);
  }
}

/**
 * Broadcast one event to a set of already-selected connections.
 */
export interface BroadcastToConnectionsOptions {
  event: string;
  payload: unknown;
  options?: PublicApi.BroadcastOptions & {
    namespace?: string;
    channel?: string;
    channelScope?: string | null;
  };
  excludeConnectionId?: string;
}

export function broadcastToConnections(
  runtime: Pick<
    OutgoingRuntime,
    | 'afterSendHooks'
    | 'beforeSendHooks'
    | 'compiled'
    | 'generateId'
    | 'logger'
    | 'pluginRuntimes'
    | 'outgoingHooks'
    | 'waitUntil'
    | 'wskitStampHooks'
  >,
  connections: readonly EngineRuntimeTypes.RuntimeConnection[],
  opts: BroadcastToConnectionsOptions,
): void {
  const { event, payload, options, excludeConnectionId } = opts;
  if (connections.length === 0) return;

  let prepared: PreparedBroadcast;
  try {
    prepared = prepareBroadcast(runtime, {
      routing: {
        namespace: options?.namespace,
        channel: options?.channel,
        channelScope: options?.channelScope,
      },
      event,
      payload,
    });
  } catch (error) {
    // A payload or declaration error fails the same way for every peer — log once.
    runtime.logger?.error('[wskit] broadcast preparation failed; no peers received', {
      event,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  for (const connection of connections) {
    if (
      excludeConnectionId &&
      (options?.excludeSelf ?? true) &&
      connection.id === excludeConnectionId
    )
      continue;
    // One bad peer must not stop the rest of the broadcast — log and continue.
    try {
      sendPrepared(runtime, connection, prepared);
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
export interface BroadcastToChannelOptions {
  channelName: string;
  event: string;
  payload: unknown;
  excludeConnectionId: string | undefined;
  channelScope: string | null;
  excludeSelf?: boolean;
}

export function broadcastToChannel(
  runtime: EngineRuntimeTypes.ConnectionMembersRuntime &
    Pick<
      OutgoingRuntime,
      | 'afterSendHooks'
      | 'beforeSendHooks'
      | 'compiled'
      | 'generateId'
      | 'logger'
      | 'pluginRuntimes'
      | 'outgoingHooks'
      | 'waitUntil'
      | 'wskitStampHooks'
    >,
  opts: BroadcastToChannelOptions,
): void {
  const { channelName, event, payload, excludeConnectionId, channelScope, excludeSelf } = opts;
  const members = runtime.channelMembers.get(
    ChannelPrimitive.createChannelMembershipKey(channelName, channelScope),
  );
  if (!members || members.size === 0) return;

  let prepared: PreparedBroadcast;
  try {
    prepared = prepareBroadcast(runtime, {
      routing: { channel: channelName, channelScope },
      event,
      payload,
    });
  } catch (error) {
    // A payload or declaration error fails the same way for every member — log once.
    runtime.logger?.error('[wskit] channel broadcast preparation failed; no members received', {
      channel: channelName,
      channelScope,
      event,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  for (const connection of members) {
    if (excludeConnectionId && (excludeSelf ?? true) && connection.id === excludeConnectionId)
      continue;
    // One bad peer must not stop the rest of the fanout — log and continue.
    try {
      sendPrepared(runtime, connection, prepared);
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
