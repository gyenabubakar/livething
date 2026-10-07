/* oxlint-disable @typescript-eslint/no-explicit-any */
import { rethrowIfConfigError } from '@livething/core';
import { runOutsideCall } from '~/_engine/call-context.ts';
import { serializeJsonOrThrow } from '~/_engine/runtime/json-guard.ts';
import * as Protocol from '~/_engine/runtime/protocol.ts';
import { serializeWireFrame } from '~/_engine/runtime/wire-serialize.ts';
import * as ChannelPrimitive from '~/channel/runtime.ts';
import { frameOwner, parsePluginWireName } from '~/plugin-scope.ts';
import { isTranslatorConfigError } from '~/translation/error.ts';
import type * as EngineCompileTypes from '~/_engine/compile/types.ts';
import type { OutgoingHookEntry } from '~/_engine/runtime/types.ts';
import type * as EngineRuntimeTypes from '~/_engine/runtime/types.ts';
import type * as PublicApi from '~/context.ts';

type RunOutgoingHooksMessageParameter = { event: string; payload: unknown };
type BroadcastToChannelOptsParameter = {
  channelName: string;
  channelFamily: string | null;
  event: string;
  payload: Record<string, unknown>;
  deliverySeq: number;
  messageId: string;
  /**
   * Skip writing an inbox row for this user. Set only when the broadcast
   * excludes their one and only connection in this channel — otherwise
   * they would never receive (and so never acknowledge) the live frame,
   * and the stored row would look like an unread message forever.
   */
  excludeUserId?: string;
};

/**
 * Minimal dependency bag for outgoing message helpers.
 */
export interface OutgoingRuntime {
  compiled: EngineCompileTypes.CompiledServer;

  outgoingHooks: readonly OutgoingHookEntry[];

  /**
   * Contributors of `__livething` metadata for outgoing user frames — the delivery sequence
   * number and the dedup id. Skipped for protocol frames.
   */
  livethingStampHooks: readonly ((event: string) => Record<string, unknown>)[];

  beforeSendHooks: readonly ((message: EngineRuntimeTypes.WireOutgoingMessage) => void)[];

  afterSendHooks: readonly ((
    message: EngineRuntimeTypes.WireOutgoingMessage,
  ) => void | Promise<void>)[];

  /** Run once per broadcast, before the recipient loop — even when nobody is live. */
  beforeBroadcastHooks?: readonly ((message: EngineRuntimeTypes.WireBroadcastMessage) => void)[];

  /** Run once per broadcast, after the recipient loop — even when nobody is live. */
  afterBroadcastHooks?: readonly ((
    message: EngineRuntimeTypes.WireBroadcastMessage,
  ) => void | Promise<void>)[];

  /** @internal Tracks engine-owned work that must finish before adapter shutdown. */
  trackBackgroundWork?: (work: Promise<void>) => void;

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
      (channel?.cursorStreams.has(event) ?? false) ||
      (channel?.recordedStreams.has(event) ?? false)
    );
  }

  return (
    compiled.outgoing.has(event) ||
    compiled.streams.has(event) ||
    compiled.cursorStreams.has(event) ||
    compiled.recordedStreams.has(event)
  );
}

/**
 * Throw if the payload is not a plain object — arrays and primitives are rejected. A stream
 * chunk is a payload too, so a generator that yields `null` lands here.
 */
export function assertPayloadRecord(
  event: string,
  payload: unknown,
): asserts payload is Record<string, unknown> {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) return;

  let got: string = typeof payload;
  if (payload === null) got = 'null';
  if (Array.isArray(payload)) got = 'an array';

  throw new Error(
    `[livething] The payload for "${event}" must be a plain object, such as { text: 'hi' }, ` +
      `but it was ${got}. A stream chunk is a payload too, so yield an object.`,
  );
}

function serializePayloadOrThrow(event: string, payload: Record<string, unknown>): string {
  return serializeJsonOrThrow(payload, `Outgoing payload for "${event}"`);
}

/** Run the owner-tagged outgoing hooks and return the (possibly rewritten) message. */
function runOutgoingHooks(
  outgoingHooks: OutgoingRuntime['outgoingHooks'],
  message: RunOutgoingHooksMessageParameter,
): { event: string; payload: unknown } {
  let current = message;

  // Owner is derived from the event name, which the hooks cannot rewrite.
  const owner = frameOwner(current.event);
  // A plugin sees its own frames with the short name it declared.
  const parsed = parsePluginWireName(current.event);
  for (const { handler, owner: hookOwner } of outgoingHooks) {
    const ownFrame =
      hookOwner.kind === 'plugin' && owner.kind === 'plugin' && hookOwner.id === owner.id;
    const event = ownFrame && parsed ? parsed.name : current.event;
    // The hook sees a frame, not a connection's ctx. The sender's call context
    // would name the wrong connection when one connection broadcasts to another.
    const next = runOutsideCall(() => handler({ event, payload: current.payload, owner }));
    if (next !== undefined) current = { event: current.event, payload: next };
  }

  assertPayloadRecord(current.event, current.payload);

  return current;
}

/**
 * Build the `__livething` block for an outgoing frame from its routing target.
 * Returns the typed envelope so each field write is checked; the caller widens
 * it to a loose bag only where plugin stampers add their own open-ended keys.
 */
function buildLiveThing(
  routing: EngineRuntimeTypes.RoutingTarget | undefined,
): Partial<Protocol.LiveThingProtocol> {
  const livething: Partial<Protocol.LiveThingProtocol> = {};
  if (routing?.channel) livething.channel = routing.channel;
  if (routing?.channelFamily !== null && routing?.channelFamily !== undefined) {
    livething.channelFamily = routing.channelFamily;
  }

  if (routing?.correlationId) livething.correlationId = routing.correlationId;
  if (routing?.source) livething.source = routing.source;

  if (routing?.streamId) livething.streamId = routing.streamId;
  if (typeof routing?.deliverySeq === 'number') livething.deliverySeq = routing.deliverySeq;
  if (typeof routing?.streamSeq === 'number') livething.streamSeq = routing.streamSeq;
  if (routing?.streamDurability) livething.streamDurability = routing.streamDurability;

  return livething;
}

/**
 * Run the sequence/dedup stampers and merge their output into `__livething`. A
 * value already set from routing wins, so a durable stream's own sequence stays.
 */
function applyLiveThingStampers(
  stampers: OutgoingRuntime['livethingStampHooks'],
  event: string,
  livething: Record<string, unknown>,
): void {
  if (Protocol.isProtocolEventName(event)) return;

  for (const stamp of stampers) {
    const stamped = stamp(event);
    for (const key in stamped) {
      if (key === 'deliverySeq' && livething.streamSeq !== undefined) continue;

      if (livething[key] === undefined) livething[key] = stamped[key];
    }
  }
}

/** Fan out after-send (or after-broadcast) hooks and log asynchronous failures. */
interface AfterHooksRun<TMessage> {
  hooks: readonly ((message: TMessage) => void | Promise<void>)[];
  message: TMessage;
  failure: string;
}

function invokeAfterHooks<TMessage>(
  runtime: Pick<OutgoingRuntime, 'logger' | 'trackBackgroundWork'>,
  run: AfterHooksRun<TMessage>,
): void {
  const { logger } = runtime;
  const { hooks, message, failure } = run;
  for (const hook of hooks) {
    try {
      const result = hook(message);

      if (result && typeof (result as Promise<unknown>).then === 'function') {
        const work = Promise.resolve(result);
        runtime.trackBackgroundWork?.(work);
        void work.catch((error) => {
          logger.error(failure, { error });
        });
      }
    } catch (error) {
      logger.error(failure, { error });
    }
  }
}

function invokeAfterSendHooks(
  runtime: Pick<OutgoingRuntime, 'afterSendHooks' | 'logger' | 'trackBackgroundWork'>,
  wireMessage: EngineRuntimeTypes.WireOutgoingMessage,
): void {
  invokeAfterHooks(runtime, {
    hooks: runtime.afterSendHooks,
    message: wireMessage,
    failure: '[livething] after-send hook failed',
  });
}

/**
 * Push one outgoing event through plugin hooks, declaration checks, and
 * `__livething` metadata before sending it to a connection.
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
  // A handler that never calls ctx.respond() answers void. Hooks still see the
  // frame — they see every server→client frame — but an empty payload is left
  // off the wire entirely so the caller resolves with nothing rather than `{}`.
  const isVoidResponse = opts.payload === undefined && isRequestResponse;
  const payload = isVoidResponse ? {} : opts.payload;
  assertPayloadRecord(event, payload);

  const message = runOutgoingHooks(runtime.outgoingHooks, { event, payload });

  if (!isRequestResponse && !isDeclaredOutgoingEvent(runtime.compiled, message.event, routing)) {
    throw new Error(
      `[livething] Outgoing event "${message.event}" was not declared in the active scope.`,
    );
  }

  // Widen to a loose bag here: from this point plugin stampers contribute
  // arbitrary, open-ended `__livething` keys that no fixed type can enumerate.
  const livething = buildLiveThing(routing) as Record<string, unknown>;
  applyLiveThingStampers(runtime.livethingStampHooks, message.event, livething);

  const finalPayload = message.payload as Record<string, unknown>;
  // A hook may answer a void acknowledgement with real data; only a still-empty
  // one is left off the wire.
  const payloadJson =
    isVoidResponse && Object.keys(finalPayload).length === 0
      ? undefined
      : serializePayloadOrThrow(message.event, finalPayload);

  const wireMessage: EngineRuntimeTypes.WireOutgoingMessage = {
    connectionId: connection.id,
    event: message.event,
    payload: finalPayload,
    livething,
    meta: connection.meta,
  };

  for (const hook of runtime.beforeSendHooks) {
    hook(wireMessage);
  }

  const sent = connection.descriptor.send(
    payloadJson === undefined
      ? serializeWireFrame(message.event, null, livething)
      : serializeWireFrame(message.event, JSON.parse(payloadJson), livething),
  );
  if (sent === false) return false;

  invokeAfterSendHooks(runtime, wireMessage);

  return true;
}

interface PreparedBroadcast {
  event: string;

  eventJson: string;

  payloadJson: string;

  finalPayload: Record<string, unknown>;

  baseLiveThing: Record<string, unknown>;

  needsWireMessage: boolean;

  /**
   * The whole frame string when it is identical for every recipient — set
   * whenever no `beforeSend` hook can rewrite `__livething` per connection. The
   * sequence/dedup stampers already ran once into `baseLiveThing`, so every
   * recipient shares these bytes and `sendPrepared` skips re-serializing.
   */
  sharedFrame?: string;
}

type BroadcastRuntime = Pick<
  OutgoingRuntime,
  | 'afterSendHooks'
  | 'beforeSendHooks'
  | 'beforeBroadcastHooks'
  | 'afterBroadcastHooks'
  | 'trackBackgroundWork'
  | 'compiled'
  | 'logger'
  | 'outgoingHooks'
  | 'livethingStampHooks'
>;

function hasBroadcastHooks(runtime: BroadcastRuntime): boolean {
  return (
    (runtime.beforeBroadcastHooks?.length ?? 0) > 0 ||
    (runtime.afterBroadcastHooks?.length ?? 0) > 0
  );
}

function toBroadcastMessage(
  prepared: PreparedBroadcast,
  userId?: string,
): EngineRuntimeTypes.WireBroadcastMessage {
  const message: EngineRuntimeTypes.WireBroadcastMessage = {
    event: prepared.event,
    payload: prepared.finalPayload,
    livething: prepared.baseLiveThing,
  };

  if (userId) message.userId = userId;

  return message;
}

function runBeforeBroadcastHooks(
  runtime: BroadcastRuntime,
  message: EngineRuntimeTypes.WireBroadcastMessage,
): void {
  for (const hook of runtime.beforeBroadcastHooks ?? []) {
    hook(message);
  }
}

/**
 * Run the before-broadcast hooks, logging instead of throwing. Returns `false`
 * when a hook threw — the broadcast must then reach nobody, so a strict replay
 * store never misses a frame its recipients saw.
 */
function tryBeforeBroadcastHooks(
  runtime: BroadcastRuntime,
  message: EngineRuntimeTypes.WireBroadcastMessage,
  details: Record<string, unknown>,
): boolean {
  try {
    runBeforeBroadcastHooks(runtime, message);
    return true;
  } catch (error) {
    rethrowIfConfigError(error);
    runtime.logger?.error('[livething] before-broadcast hook failed; no recipient received it', {
      ...details,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

function runAfterBroadcastHooks(
  runtime: BroadcastRuntime,
  message: EngineRuntimeTypes.WireBroadcastMessage,
): void {
  invokeAfterHooks(runtime, {
    hooks: runtime.afterBroadcastHooks ?? [],
    message,
    failure: '[livething] after-broadcast hook failed',
  });
}

/**
 * Run the recipient-independent half of the send pipeline once for a whole
 * broadcast: outgoing hooks, the declaration check, the base `__livething` block,
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
  assertPayloadRecord(event, payload);

  const message = runOutgoingHooks(runtime.outgoingHooks, {
    event,
    payload,
  });

  if (!isDeclaredOutgoingEvent(runtime.compiled, message.event, routing)) {
    throw new Error(
      `[livething] Outgoing event "${message.event}" was not declared in the active scope.`,
    );
  }

  const finalPayload = message.payload as Record<string, unknown>;
  const payloadJson = serializePayloadOrThrow(message.event, finalPayload);

  // Stamp once for the whole broadcast: all recipients share one deliverySeq/messageId, so replay stores one row, not one per member.
  const baseLiveThing = buildLiveThing(routing) as Record<string, unknown>;
  applyLiveThingStampers(runtime.livethingStampHooks, message.event, baseLiveThing);

  const hasBeforeSend = runtime.beforeSendHooks.length > 0;

  return {
    event: message.event,
    eventJson: JSON.stringify(message.event),
    payloadJson,
    finalPayload,
    baseLiveThing,
    needsWireMessage: hasBeforeSend || runtime.afterSendHooks.length > 0,
    sharedFrame: hasBeforeSend
      ? undefined
      : serializeWireFrame(message.event, finalPayload, baseLiveThing),
  };
}

/**
 * Send one prepared broadcast frame to a single recipient. Only per-connection
 * work runs here — `__livething` stamping, before/after-send hooks, the wire write.
 * The frame splices in the prepared payload JSON, so the payload is never
 * re-serialized per recipient.
 */
function sendPrepared(
  runtime: BroadcastRuntime,
  connection: EngineRuntimeTypes.RuntimeConnection,
  prepared: PreparedBroadcast,
): boolean {
  // Shared-frame fast path: the bytes are the same for everyone, so just
  // write the prepared string. beforeSend is empty here (it disqualifies a
  // shared frame), so only an afterSend hook still needs the wire message.
  if (prepared.sharedFrame !== undefined) {
    if (connection.descriptor.send(prepared.sharedFrame) === false) return false;

    if (prepared.needsWireMessage) {
      invokeAfterSendHooks(runtime, {
        connectionId: connection.id,
        event: prepared.event,
        payload: prepared.finalPayload,
        livething: prepared.baseLiveThing,
        meta: connection.meta,
      });
    }

    return true;
  }

  const livething = { ...prepared.baseLiveThing };

  let wireMessage: EngineRuntimeTypes.WireOutgoingMessage | undefined;
  if (prepared.needsWireMessage) {
    wireMessage = {
      connectionId: connection.id,
      event: prepared.event,
      payload: prepared.finalPayload,
      livething,
      meta: connection.meta,
    };
    for (const hook of runtime.beforeSendHooks) {
      hook(wireMessage);
    }
  }

  if (
    connection.descriptor.send(
      serializeWireFrame(prepared.event, prepared.finalPayload, livething),
    ) === false
  ) {
    return false;
  }

  if (wireMessage) {
    invokeAfterSendHooks(runtime, wireMessage);
  }

  return true;
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
  runtime: BroadcastRuntime & Pick<OutgoingRuntime, 'generateId'>,
  connections: Iterable<EngineRuntimeTypes.RuntimeConnection>,
  opts: BroadcastToConnectionsOptions,
): void {
  const { event, payload, options, excludeConnectionId } = opts;

  function prepareOrLog(): PreparedBroadcast | undefined {
    try {
      return prepareBroadcast(runtime, {
        routing: {
          channel: options?.channel,
          channelFamily: options?.channelFamily,
        },
        event,
        payload,
      });
    } catch (error) {
      rethrowIfConfigError(error);
      // A payload or declaration error fails the same way for every peer — log once.
      runtime.logger?.error('[livething] broadcast preparation failed; no peers received', {
        event,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  // Without broadcast hooks the frame is prepared on the first eligible peer,
  // so a broadcast that reaches nobody never pays to serialize, and the caller
  // can hand over a live view of the connections rather than a copy of it.
  // With them (built-in replay), it is prepared up front so the broadcast is
  // recorded once even when nobody receives it live.
  let prepared: PreparedBroadcast | undefined;
  let recorded: EngineRuntimeTypes.WireBroadcastMessage | undefined;
  if (hasBroadcastHooks(runtime)) {
    prepared = prepareOrLog();
    if (!prepared) return;

    recorded = toBroadcastMessage(prepared);
    if (!tryBeforeBroadcastHooks(runtime, recorded, { event })) return;
  }

  for (const connection of connections) {
    if (
      excludeConnectionId &&
      !(options?.includeSelf ?? false) &&
      connection.id === excludeConnectionId
    )
      continue;

    if (!prepared) {
      prepared = prepareOrLog();
      if (!prepared) return;
    }

    // One bad peer must not stop the rest of the broadcast — log and continue.
    try {
      sendPrepared(runtime, connection, prepared);
    } catch (error) {
      if (!isTranslatorConfigError(error)) rethrowIfConfigError(error);
      runtime.logger?.error('[livething] broadcast send to one peer threw; continuing fanout', {
        connectionId: connection.id,
        event,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (recorded) runAfterBroadcastHooks(runtime, recorded);
}

/**
 * Send one event to every live connection of one user, optionally inside one
 * channel.
 */
export interface BroadcastToUserOptions {
  userId: string;

  event: string;

  payload: unknown;

  channelName?: string;

  channelFamily?: string | null;
}

/**
 * Send one event to the given connections of one user. The frame is stamped
 * once, so every tab shares one `deliverySeq`/`messageId`, and the broadcast
 * hooks see it once for that user — even when none of the user's tabs is
 * live — so replay can hand it to the user's next connection. Returns the
 * number of sockets reached. An empty `userId` (the `ctx.user` of an anonymous
 * connection) addresses nobody. A payload or declaration error throws.
 */
export function broadcastToUser(
  runtime: BroadcastRuntime,
  connections: readonly EngineRuntimeTypes.RuntimeConnection[],
  opts: BroadcastToUserOptions,
): number {
  const { userId, event, payload, channelName, channelFamily } = opts;
  if (!userId) return 0;

  const records = hasBroadcastHooks(runtime);
  if (connections.length === 0 && !records) return 0;

  const prepared = prepareBroadcast(runtime, {
    routing: channelName ? { channel: channelName, channelFamily } : undefined,
    event,
    payload,
  });
  const recorded = records ? toBroadcastMessage(prepared, userId) : undefined;
  if (recorded) runBeforeBroadcastHooks(runtime, recorded);

  let delivered = 0;
  for (const connection of connections) {
    if (sendPrepared(runtime, connection, prepared)) delivered += 1;
  }

  if (recorded) runAfterBroadcastHooks(runtime, recorded);

  return delivered;
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
    BroadcastRuntime &
    Pick<OutgoingRuntime, 'generateId'> & {
      /**
       * Write a durable inbox copy for every member of the channel, keyed on the
       * `seq`/`messageId` this broadcast already stamped so a member's live frame
       * and its inbox row share one identity. Runs once, before the recipient
       * loop. A no-op for a non-inbox channel. Set only when `inbox()` is listed.
       */
      inboxFanOut?: (opts: BroadcastToChannelOptsParameter) => void;
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
    rethrowIfConfigError(error);
    // A payload or declaration error fails the same way for every member — log once.
    runtime.logger?.error('[livething] channel broadcast preparation failed; no members received', {
      channel: channelName,
      channelFamily,
      event,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  // Recorded before the member lookup, so a broadcast to a channel with no
  // live member (or only the excluded sender) still reaches the replay store.
  let recorded: EngineRuntimeTypes.WireBroadcastMessage | undefined;
  if (hasBroadcastHooks(runtime)) {
    recorded = toBroadcastMessage(prepared);
    const details = { channel: channelName, channelFamily, event };
    if (!tryBeforeBroadcastHooks(runtime, recorded, details)) return;
  }

  const members = runtime.channelMembers.get(
    ChannelPrimitive.createChannelMembershipKey(channelName, channelFamily),
  );

  const { deliverySeq, messageId } = prepared.baseLiveThing;
  if (
    runtime.inboxFanOut &&
    !Protocol.isProtocolEventName(prepared.event) &&
    typeof deliverySeq === 'number' &&
    typeof messageId === 'string'
  ) {
    try {
      runtime.inboxFanOut({
        channelName,
        channelFamily,
        event: prepared.event,
        payload: prepared.finalPayload,
        deliverySeq,
        messageId,
        excludeUserId: includeSelf
          ? undefined
          : soleExcludedMemberUserId(members, excludeConnectionId),
      });
    } catch (error) {
      rethrowIfConfigError(error);
      runtime.logger?.error('[livething] inbox fan-out failed; live broadcast still proceeds', {
        channel: channelName,
        channelFamily,
        event,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  for (const connection of members ?? []) {
    if (excludeConnectionId && !(includeSelf ?? false) && connection.id === excludeConnectionId)
      continue;

    // One bad peer must not stop the rest of the fanout — log and continue.
    try {
      sendPrepared(runtime, connection, prepared);
    } catch (error) {
      if (!isTranslatorConfigError(error)) rethrowIfConfigError(error);
      runtime.logger?.error(
        '[livething] channel broadcast send to one peer threw; continuing fanout',
        {
          connectionId: connection.id,
          channel: channelName,
          channelFamily,
          event,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }

  if (recorded) runAfterBroadcastHooks(runtime, recorded);
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
