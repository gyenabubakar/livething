/* oxlint-disable @typescript-eslint/no-explicit-any */
import { rethrowIfConfigError } from '@livething/core';
import { isInsideOutgoingHook, runOutgoingHook } from '~/_engine/call-context.ts';
import { assertPayload, serializePayload } from '~/_engine/runtime/json-guard.ts';
import * as Protocol from '~/_engine/runtime/protocol.ts';
import { serializeWireFrame } from '~/_engine/runtime/wire-serialize.ts';
import * as ChannelPrimitive from '~/channel/runtime.ts';
import { frameOwner, parsePluginWireName } from '~/plugin-scope.ts';
import type * as EngineCompileTypes from '~/_engine/compile/types.ts';
import type { OutgoingHookEntry } from '~/_engine/runtime/types.ts';
import type * as EngineRuntimeTypes from '~/_engine/runtime/types.ts';
import type * as PublicApi from '~/context.ts';
import type * as InterceptPrimitive from '~/intercept/intercept.ts';

type BroadcastToChannelOptsParameter = {
  channelName: string;
  channelFamily: string | null;
  event: string;
  payload: Record<string, unknown> | null;
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
 * scope check by looking protocol-shaped. A plugin's namespaced
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
      (channel?.recordedStreams.has(event) ?? false)
    );
  }

  return (
    compiled.outgoing.has(event) ||
    compiled.streams.has(event) ||
    compiled.recordedStreams.has(event)
  );
}

/** One finished send, as the `onOutgoing` hooks see it. */
interface SentFrame {
  event: string;
  payload: unknown;
  routing: EngineRuntimeTypes.RoutingTarget | undefined;
  target: InterceptPrimitive.OutgoingTarget;
  recipients: number;
}

/**
 * Show one finished send to every `onOutgoing` hook. Protocol frames are not
 * shown, and neither is a send made inside an `onOutgoing` hook, which would
 * otherwise run the hook again without end. A hook only watches: what it throws,
 * or a promise it returns that rejects, is logged and never reaches the sender —
 * except a configuration error, which is rethrown so the developer sees it.
 */
function notifyOutgoing(
  runtime: Pick<OutgoingRuntime, 'outgoingHooks' | 'logger' | 'trackBackgroundWork'>,
  sent: SentFrame,
): void {
  if (
    runtime.outgoingHooks.length === 0 ||
    Protocol.isProtocolEventName(sent.event) ||
    isInsideOutgoingHook()
  ) {
    return;
  }

  const owner = frameOwner(sent.event);
  // A plugin sees its own frames with the short name it declared.
  const parsed = parsePluginWireName(sent.event);
  const channel = sent.routing?.channel
    ? { name: sent.routing.channel, family: sent.routing.channelFamily ?? null }
    : null;

  invokeAfterHooks(runtime, {
    hooks: runtime.outgoingHooks.map((hook) => {
      const ownFrame =
        hook.owner.kind === 'plugin' && owner.kind === 'plugin' && hook.owner.id === owner.id;
      const frame: InterceptPrimitive.OutgoingFrame = {
        event: ownFrame && parsed ? parsed.name : sent.event,
        payload: sent.payload,
        owner,
        channel,
        target: sent.target,
        recipients: sent.recipients,
      };

      // The hook sees a frame, not the call context of the code that sent it.
      return () => runOutgoingHook(() => hook.handler(frame));
    }),
    message: undefined,
    failure: '[livething] onOutgoing hook failed',
    rethrowConfigErrors: true,
  });
}

/** Who a channel recipient selector addresses, for the `onOutgoing` hooks. */
export function outgoingTargetOf(
  to: PublicApi.ChannelRecipient,
): InterceptPrimitive.OutgoingTarget {
  switch (to.__livething) {
    case 'connection-ref':
      return { kind: 'connection', id: to.id };

    case 'user-ref':
      return { kind: 'user', id: to.id };

    case 'tag-ref':
      return { kind: 'tag', tagKind: to.kind, group: to.group, key: to.key };

    case 'group-handle':
      return { kind: 'tag', tagKind: to.kind, group: to.group };
  }
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

/** Run hooks that only watch, and log their failures instead of throwing. */
interface AfterHooksRun<TMessage> {
  hooks: readonly ((message: TMessage) => void | Promise<void>)[];
  message: TMessage;
  failure: string;
  /** Rethrow a configuration error a hook throws, so the developer sees it. */
  rethrowConfigErrors?: boolean;
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
      if (run.rethrowConfigErrors) rethrowIfConfigError(error);
      logger.error(failure, { error });
    }
  }
}

/**
 * Check one outgoing event, add its `__livething` metadata, send it to one
 * connection, then show it to the `onOutgoing` hooks.
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
  if (connection.purged) return false;

  const { routing, event } = opts;
  const isRequestResponse = !!routing?.correlationId;
  // A handler that never calls ctx.respond() answers void. Its payload is left
  // off the wire entirely so the caller resolves with nothing rather than `{}`.
  const isVoidResponse = opts.payload === undefined && isRequestResponse;
  if (!isVoidResponse) assertPayload(event, opts.payload);

  if (!isRequestResponse && !isDeclaredOutgoingEvent(runtime.compiled, event, routing)) {
    throw new Error(`[livething] Outgoing event "${event}" was not declared in the active scope.`);
  }

  // Widen to a loose bag here: from this point plugin stampers contribute
  // arbitrary, open-ended `__livething` keys that no fixed type can enumerate.
  const livething = buildLiveThing(routing) as Record<string, unknown>;
  applyLiveThingStampers(runtime.livethingStampHooks, event, livething);

  const wirePayload = isVoidResponse
    ? null
    : (JSON.parse(serializePayload(event, opts.payload)) as Record<string, unknown> | null);

  let recorded: EngineRuntimeTypes.WireBroadcastMessage | undefined;
  if (!isRequestResponse && hasBroadcastHooks(runtime)) {
    const recipients = recipientsOf([connection]);
    if (recipients.length > 0) {
      recorded = { event, payload: wirePayload, livething, recipients };
      if (!tryBeforeBroadcastHooks(runtime, recorded, { event, connectionId: connection.id })) {
        return false;
      }
    }
  }

  const text = serializeWireFrame(event, wirePayload, livething);
  const sent = connection.descriptor.send({ kind: 'text', text }) !== false;
  if (recorded) runAfterBroadcastHooks(runtime, recorded);

  notifyOutgoing(runtime, {
    event,
    payload: wirePayload,
    routing,
    target: { kind: 'connection', id: connection.id },
    recipients: sent ? 1 : 0,
  });

  return sent;
}

interface PreparedBroadcast {
  event: string;

  finalPayload: Record<string, unknown> | null;

  baseLiveThing: Record<string, unknown>;

  /**
   * The whole frame string, identical for every recipient. The sequence/dedup
   * stampers already ran once into `baseLiveThing`, so every recipient shares
   * these bytes. Built on first use.
   */
  frame?: string;
}

function sharedFrame(prepared: PreparedBroadcast): string {
  return (prepared.frame ??= serializeWireFrame(
    prepared.event,
    prepared.finalPayload,
    prepared.baseLiveThing,
  ));
}

type BroadcastRuntime = Pick<
  OutgoingRuntime,
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
 * broadcast: the payload and declaration checks, the base `__livething` block,
 * and JSON serialization. Every recipient reuses the result.
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
  assertPayload(event, payload);

  // A server request is declared by `serverRequests(...)`, not `emits(...)`, and its
  // routing carries `source`, so it skips the outgoing-event check.
  if (!routing?.source && !isDeclaredOutgoingEvent(runtime.compiled, event, routing)) {
    throw new Error(`[livething] Outgoing event "${event}" was not declared in the active scope.`);
  }

  // From here every frame, recipient and hook uses this plain copy of what was serialized, so a
  // toJSON() runs once for the whole broadcast and every peer gets the same payload.
  const finalPayload = JSON.parse(serializePayload(event, payload)) as Record<
    string,
    unknown
  > | null;

  // Stamp once for the whole broadcast: all recipients share one deliverySeq/messageId, so replay stores one row, not one per member.
  const baseLiveThing = buildLiveThing(routing) as Record<string, unknown>;
  applyLiveThingStampers(runtime.livethingStampHooks, event, baseLiveThing);

  return { event, finalPayload, baseLiveThing };
}

/** Write one prepared broadcast frame to a single recipient. */
function sendPrepared(
  connection: EngineRuntimeTypes.RuntimeConnection,
  prepared: PreparedBroadcast,
): boolean {
  if (connection.purged) return false;

  return connection.descriptor.send({ kind: 'text', text: sharedFrame(prepared) }) !== false;
}

function notifyPrepared(
  runtime: BroadcastRuntime,
  prepared: PreparedBroadcast,
  sent: Pick<SentFrame, 'routing' | 'target' | 'recipients'>,
): void {
  notifyOutgoing(runtime, { event: prepared.event, payload: prepared.finalPayload, ...sent });
}

/** Options for one send to a set of connections. */
export interface SharedSendOptions {
  routing: EngineRuntimeTypes.RoutingTarget | undefined;
  event: string;
  payload: unknown;
  target: InterceptPrimitive.OutgoingTarget;
}

/**
 * One send to many connections. The payload is checked, serialized and stamped
 * once, so every recipient gets the same payload and the same
 * `deliverySeq`/`messageId`. Throws when the payload or the event is invalid.
 */
export interface SharedSend {
  /**
   * Write the frame to one connection, and return whether it was written.
   * `extra` adds per-recipient `__livething` fields (a server request leg's
   * correlation id); the frame is then serialized for this recipient only.
   */
  deliver(
    connection: EngineRuntimeTypes.RuntimeConnection,
    extra?: Record<string, unknown>,
  ): boolean;
  /** Show the finished send, with its recipient count, to the `onOutgoing` hooks. */
  finish(): void;
}

export function openSharedSend(runtime: BroadcastRuntime, opts: SharedSendOptions): SharedSend {
  return openPreparedSend(runtime, prepareBroadcast(runtime, opts), opts);
}

function openPreparedSend(
  runtime: BroadcastRuntime,
  prepared: PreparedBroadcast,
  opts: SharedSendOptions,
): SharedSend {
  let recipients = 0;

  return {
    deliver(connection, extra) {
      if (connection.purged) return false;

      const frame = extra
        ? serializeWireFrame(prepared.event, prepared.finalPayload, {
            ...prepared.baseLiveThing,
            ...extra,
          })
        : sharedFrame(prepared);
      const sent = connection.descriptor.send({ kind: 'text', text: frame }) !== false;
      if (sent) recipients += 1;

      return sent;
    },
    finish() {
      notifyPrepared(runtime, prepared, { routing: opts.routing, target: opts.target, recipients });
    },
  };
}

/**
 * Send one event to an already-chosen set of connections as one shared frame.
 * Returns how many sockets got it. A payload or declaration error throws; a
 * failure to write to one peer is logged and the rest still get the frame.
 */
export function sendToConnections(
  runtime: BroadcastRuntime,
  connections: Iterable<EngineRuntimeTypes.RuntimeConnection>,
  opts: SharedSendOptions,
): number {
  const prepared = prepareBroadcast(runtime, opts);
  const targets = hasBroadcastHooks(runtime) ? [...connections] : connections;
  let recorded: EngineRuntimeTypes.WireBroadcastMessage | undefined;
  if (hasBroadcastHooks(runtime)) {
    const recipients = recipientsOf(targets);
    if (recipients.length > 0) {
      recorded = { ...toBroadcastMessage(prepared), recipients };
      if (!tryBeforeBroadcastHooks(runtime, recorded, { event: opts.event })) return 0;
    }
  }

  const send = openPreparedSend(runtime, prepared, opts);
  let delivered = 0;
  for (const connection of targets) {
    try {
      if (send.deliver(connection)) delivered += 1;
    } catch (error) {
      rethrowIfConfigError(error);
      runtime.logger?.error('[livething] send to one peer threw; continuing fanout', {
        connectionId: connection.id,
        event: opts.event,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  send.finish();
  if (recorded) runAfterBroadcastHooks(runtime, recorded);

  return delivered;
}

/** The connections a frame can be handed back to after a reconnect: those with a resume token. */
function recipientsOf(
  connections: Iterable<EngineRuntimeTypes.RuntimeConnection>,
): EngineRuntimeTypes.FrameRecipient[] {
  const recipients: EngineRuntimeTypes.FrameRecipient[] = [];
  for (const connection of connections) {
    if (connection.resumeToken) {
      recipients.push({ userId: connection.userId, resumeToken: connection.resumeToken });
    }
  }

  return recipients;
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

  /** The resume token of `excludeConnectionId`, so replay leaves out that sender too. */
  excludeResumeToken?: string;
}

export function broadcastToConnections(
  runtime: BroadcastRuntime & Pick<OutgoingRuntime, 'generateId'>,
  connections: Iterable<EngineRuntimeTypes.RuntimeConnection>,
  opts: BroadcastToConnectionsOptions,
): void {
  const { event, payload, options, excludeConnectionId, excludeResumeToken } = opts;

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

  // Without broadcast or onOutgoing hooks the frame is prepared on the first
  // eligible peer, so a broadcast that reaches nobody never pays to serialize,
  // and the caller can hand over a live view of the connections rather than a
  // copy of it. With them, it is prepared up front so the broadcast is recorded
  // and shown to the hooks once even when nobody receives it live.
  let prepared: PreparedBroadcast | undefined;
  let recorded: EngineRuntimeTypes.WireBroadcastMessage | undefined;
  if (hasBroadcastHooks(runtime) || runtime.outgoingHooks.length > 0) {
    prepared = prepareOrLog();
    if (!prepared) return;
  }

  if (prepared && hasBroadcastHooks(runtime)) {
    recorded = toBroadcastMessage(prepared);
    if (excludeResumeToken && !options?.includeSelf) {
      recorded.excludedResumeToken = excludeResumeToken;
    }

    if (!tryBeforeBroadcastHooks(runtime, recorded, { event })) return;
  }

  let recipients = 0;
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
      if (sendPrepared(connection, prepared)) recipients += 1;
    } catch (error) {
      rethrowIfConfigError(error);
      runtime.logger?.error('[livething] broadcast send to one peer threw; continuing fanout', {
        connectionId: connection.id,
        event,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (recorded) runAfterBroadcastHooks(runtime, recorded);

  if (prepared) {
    const routing = { channel: options?.channel, channelFamily: options?.channelFamily };
    notifyPrepared(runtime, prepared, {
      routing,
      target: options?.channel ? { kind: 'channel' } : { kind: 'all' },
      recipients,
    });
  }
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
  if (connections.length === 0 && !records && runtime.outgoingHooks.length === 0) return 0;

  const routing = channelName ? { channel: channelName, channelFamily } : undefined;
  const prepared = prepareBroadcast(runtime, { routing, event, payload });
  const recorded = records ? toBroadcastMessage(prepared, userId) : undefined;
  if (recorded) runBeforeBroadcastHooks(runtime, recorded);

  let delivered = 0;
  for (const connection of connections) {
    try {
      if (sendPrepared(connection, prepared)) delivered += 1;
    } catch (error) {
      rethrowIfConfigError(error);
      runtime.logger?.error('[livething] user broadcast send to one tab threw; continuing fanout', {
        connectionId: connection.id,
        event,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (recorded) runAfterBroadcastHooks(runtime, recorded);

  notifyPrepared(runtime, prepared, {
    routing,
    target: { kind: 'user', id: userId },
    recipients: delivered,
  });

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

  /** The resume token of `excludeConnectionId`, so replay leaves out that sender too. */
  excludeResumeToken?: string;

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
    if (opts.excludeResumeToken && !includeSelf) {
      recorded.excludedResumeToken = opts.excludeResumeToken;
    }

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

  let recipients = 0;
  for (const connection of members ?? []) {
    if (excludeConnectionId && !(includeSelf ?? false) && connection.id === excludeConnectionId)
      continue;

    // One bad peer must not stop the rest of the fanout — log and continue.
    try {
      if (sendPrepared(connection, prepared)) recipients += 1;
    } catch (error) {
      rethrowIfConfigError(error);
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

  notifyPrepared(runtime, prepared, {
    routing: { channel: channelName, channelFamily },
    target: { kind: 'channel' },
    recipients,
  });
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
