/* oxlint-disable @typescript-eslint/no-explicit-any */
import { serializeJsonOrThrow } from '~/_engine/runtime/json-guard.ts';
import * as Protocol from '~/_engine/runtime/protocol.ts';
import * as ChannelPrimitive from '~/channel/runtime.ts';
import { hookRunsForFrame } from '~/intercept/intercept.ts';
import { frameOwner, parsePluginWireName } from '~/plugin-scope.ts';
import type * as EngineCompileTypes from '~/_engine/compile/types.ts';
import type { OutgoingHookEntry } from '~/_engine/runtime/types.ts';
import type * as EngineRuntimeTypes from '~/_engine/runtime/types.ts';
import type * as PublicApi from '~/context.ts';

/**
 * Minimal dependency bag for outgoing message helpers.
 */
export interface OutgoingRuntime {
  compiled: EngineCompileTypes.CompiledServer;

  outgoingHooks: readonly OutgoingHookEntry[];

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

/**
 * Check whether an outgoing event was declared in the correct scope.
 *
 * Real protocol events — the fixed set the engine sends, like `__memberJoin__`
 * — are allowed. An unknown `__x__` name is not, so it cannot slip past the
 * scope check by looking protocol-shaped. A new-model plugin's namespaced
 * `emits()` lives in the normal outgoing/channel maps, so it is found by the
 * scope checks below.
 */
export function isDeclaredOutgoingEvent(
  compiled: EngineCompileTypes.CompiledServer,
  event: string,
  routing?: EngineRuntimeTypes.RoutingTarget,
): boolean {
  if (Protocol.OUTGOING_PROTOCOL_EVENT_NAMES.has(event)) return true;

  if (routing?.channel) {
    const channel =
      routing.channelFamily === null || routing.channelFamily === undefined
        ? compiled.channels.get(routing.channel)
        : compiled.channelFamilies.get(routing.channelFamily);
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

/** Throw if the payload is not a plain object — arrays and primitives are rejected. */
export function assertPayloadRecord(payload: unknown): asserts payload is Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('[wskit] Outgoing payload must be a plain object.');
  }
}

function serializePayloadOrThrow(event: string, payload: Record<string, unknown>): string {
  return serializeJsonOrThrow(payload, `Outgoing payload for "${event}"`);
}

/** Run the owner-tagged outgoing hooks and return the (possibly rewritten) message. */
function runOutgoingHooks(
  outgoingHooks: OutgoingRuntime['outgoingHooks'],
  message: { event: string; payload: unknown },
): { event: string; payload: unknown } {
  let current = message;

  // Owner is derived from the event name, which the hooks cannot rewrite.
  const owner = frameOwner(current.event);
  // A plugin's own-frame hook sees the short name it declared; an app hook (and
  // an observed app frame) sees the event unchanged.
  const parsed = parsePluginWireName(current.event);
  for (const { handler, owner: hookOwner } of outgoingHooks) {
    if (!hookRunsForFrame(hookOwner, owner)) continue;
    const ownFrame = hookOwner.owner.kind === 'plugin' && owner.kind === 'plugin';
    const event = ownFrame && parsed ? parsed.name : current.event;
    const next = handler({ event, payload: current.payload, owner });
    if (next !== undefined) current = { event: current.event, payload: next };
  }

  assertPayloadRecord(current.payload);
  return current;
}

/**
 * Build the `__wskit` block for an outgoing frame from its routing target.
 * Returns the typed envelope so each field write is checked; the caller widens
 * it to a loose bag only where plugin stampers add their own open-ended keys.
 */
function buildWSKit(
  routing: EngineRuntimeTypes.RoutingTarget | undefined,
): Partial<Protocol.WSKitProtocol> {
  const wskit: Partial<Protocol.WSKitProtocol> = {};
  if (routing?.channel) wskit.channel = routing.channel;
  if (routing?.channelFamily !== null && routing?.channelFamily !== undefined) {
    wskit.channelFamily = routing.channelFamily;
  }
  if (routing?.correlationId) wskit.correlationId = routing.correlationId;
  if (routing?.source) wskit.source = routing.source;
  if (routing?.streamId) wskit.streamId = routing.streamId;
  if (typeof routing?.seq === 'number') wskit.seq = routing.seq;
  if (routing?.streamKind) wskit.streamKind = routing.streamKind;
  return wskit;
}

/**
 * Run the sequence/dedup stampers and merge their output into `__wskit`. A
 * value already set from routing wins, so a durable stream's own `seq` stays.
 */
function applyWSKitStampers(
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
  const { routing, event } = opts;
  const isRequestResponse = !!routing?.correlationId;
  const payload = opts.payload === undefined && isRequestResponse ? {} : opts.payload;
  assertPayloadRecord(payload);

  const message = runOutgoingHooks(runtime.outgoingHooks, {
    event,
    payload,
  });

  if (!isRequestResponse && !isDeclaredOutgoingEvent(runtime.compiled, message.event, routing)) {
    throw new Error(
      `[wskit] Outgoing event "${message.event}" was not declared in the active scope.`,
    );
  }

  // Widen to a loose bag here: from this point plugin stampers contribute
  // arbitrary, open-ended `__wskit` keys that no fixed type can enumerate.
  const wskit = buildWSKit(routing) as Record<string, unknown>;
  applyWSKitStampers(runtime.wskitStampHooks, message.event, wskit);

  const finalPayload = message.payload as Record<string, unknown>;
  const payloadJson = serializePayloadOrThrow(message.event, finalPayload);

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
    `{"event":${JSON.stringify(message.event)},"payload":${payloadJson},"__wskit":${JSON.stringify(wskit)}}`,
  );

  invokeAfterSendHooks(runtime, wireMessage);

  return true;
}

interface PreparedBroadcast {
  event: string;

  eventJson: string;

  payloadJson: string;

  finalPayload: Record<string, unknown>;

  baseWSKit: Record<string, unknown>;

  needsWireMessage: boolean;

  /**
   * The whole frame string when it is identical for every recipient — set
   * whenever no `beforeSend` hook can rewrite `__wskit` per connection. The
   * sequence/dedup stampers already ran once into `baseWSKit`, so every
   * recipient shares these bytes and `sendPrepared` skips re-serializing.
   */
  sharedFrame?: string;
}

type BroadcastRuntime = Pick<
  OutgoingRuntime,
  | 'afterSendHooks'
  | 'beforeSendHooks'
  | 'compiled'
  | 'logger'
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

  const message = runOutgoingHooks(runtime.outgoingHooks, {
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
  const payloadJson = serializePayloadOrThrow(message.event, finalPayload);

  // Stamp once for the whole broadcast: all recipients share one seq/messageId, so replay stores one row, not one per member.
  const baseWSKit = buildWSKit(routing) as Record<string, unknown>;
  applyWSKitStampers(runtime.wskitStampHooks, message.event, baseWSKit);

  const hasBeforeSend = runtime.beforeSendHooks.length > 0;

  return {
    event: message.event,
    eventJson,
    payloadJson,
    finalPayload,
    baseWSKit,
    needsWireMessage: hasBeforeSend || runtime.afterSendHooks.length > 0,
    sharedFrame: hasBeforeSend
      ? undefined
      : `{"event":${eventJson},"payload":${payloadJson},"__wskit":${JSON.stringify(baseWSKit)}}`,
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
        wskit: prepared.baseWSKit,
        meta: connection.meta,
      });
    }
    return;
  }

  const wskit = { ...prepared.baseWSKit };

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
    channel?: string;
    channelFamily?: string | null;
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
    | 'outgoingHooks'
    | 'waitUntil'
    | 'wskitStampHooks'
  >,
  connections: Iterable<EngineRuntimeTypes.RuntimeConnection>,
  opts: BroadcastToConnectionsOptions,
): void {
  const { event, payload, options, excludeConnectionId } = opts;

  // Prepared on the first eligible peer, so a broadcast that reaches nobody
  // never pays to serialize, and the caller can hand over a live view of the
  // connections rather than a copy of it.
  let prepared: PreparedBroadcast | undefined;

  for (const connection of connections) {
    if (
      excludeConnectionId &&
      !(options?.includeSelf ?? false) &&
      connection.id === excludeConnectionId
    )
      continue;

    if (!prepared) {
      try {
        prepared = prepareBroadcast(runtime, {
          routing: {
            channel: options?.channel,
            channelFamily: options?.channelFamily,
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
    }

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

  channelFamily: string | null;

  /** Whether to also deliver to `excludeConnectionId`. Defaults to `false`. */
  includeSelf?: boolean;
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
      | 'outgoingHooks'
      | 'waitUntil'
      | 'wskitStampHooks'
    > & {
      /**
       * Write a durable inbox copy for every member of the channel, keyed on the
       * `seq`/`messageId` this broadcast already stamped so a member's live frame
       * and its inbox row share one identity. Runs once, before the recipient
       * loop. A no-op for a non-inbox channel. Set only when `inbox()` is listed.
       */
      inboxFanOut?: (opts: {
        channelName: string;
        channelFamily: string | null;
        event: string;
        payload: Record<string, unknown>;
        seq: number;
        messageId: string;
        /**
         * Skip writing an inbox row for this user. Set only when the broadcast
         * excludes their one and only connection in this channel — otherwise
         * they would never receive (and so never acknowledge) the live frame,
         * and the stored row would look like an unread message forever.
         */
        excludeUserId?: string;
      }) => void;
    },
  opts: BroadcastToChannelOptions,
): void {
  const { channelName, event, payload, excludeConnectionId, channelFamily, includeSelf } = opts;

  let prepared: PreparedBroadcast;
  try {
    prepared = prepareBroadcast(runtime, {
      routing: { channel: channelName, channelFamily },
      event,
      payload,
    });
  } catch (error) {
    // A payload or declaration error fails the same way for every member — log once.
    runtime.logger?.error('[wskit] channel broadcast preparation failed; no members received', {
      channel: channelName,
      channelFamily,
      event,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  const members = runtime.channelMembers.get(
    ChannelPrimitive.createChannelMembershipKey(channelName, channelFamily),
  );

  const { seq, messageId } = prepared.baseWSKit;
  if (
    runtime.inboxFanOut &&
    !Protocol.isProtocolEventName(prepared.event) &&
    typeof seq === 'number' &&
    typeof messageId === 'string'
  ) {
    try {
      runtime.inboxFanOut({
        channelName,
        channelFamily,
        event: prepared.event,
        payload: prepared.finalPayload,
        seq,
        messageId,
        excludeUserId: includeSelf
          ? undefined
          : soleExcludedMemberUserId(members, excludeConnectionId),
      });
    } catch (error) {
      runtime.logger?.error('[wskit] inbox fan-out failed; live broadcast still proceeds', {
        channel: channelName,
        channelFamily,
        event,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (!members || members.size === 0) return;

  for (const connection of members) {
    if (excludeConnectionId && !(includeSelf ?? false) && connection.id === excludeConnectionId)
      continue;
    // One bad peer must not stop the rest of the fanout — log and continue.
    try {
      sendPrepared(runtime, connection, prepared);
    } catch (error) {
      runtime.logger?.error('[wskit] channel broadcast send to one peer threw; continuing fanout', {
        connectionId: connection.id,
        channel: channelName,
        channelFamily,
        event,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * The excluded connection's user id, but only when that connection is the
 * user's only membership in `members` — a second tab still in the channel
 * will receive the live frame and must still get its inbox row, since it will
 * ack it. Returns `undefined` when there is nothing to exclude.
 */
function soleExcludedMemberUserId(
  members: Set<EngineRuntimeTypes.RuntimeConnection> | undefined,
  excludeConnectionId: string | undefined,
): string | undefined {
  if (!excludeConnectionId || !members) return undefined;

  let excludedUserId: string | undefined;
  for (const connection of members) {
    if (connection.id === excludeConnectionId && connection.userId) {
      excludedUserId = connection.userId;
      break;
    }
  }
  if (!excludedUserId) return undefined;

  for (const connection of members) {
    if (connection.id !== excludeConnectionId && connection.userId === excludedUserId) {
      return undefined;
    }
  }
  return excludedUserId;
}
