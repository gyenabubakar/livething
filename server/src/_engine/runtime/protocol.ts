/**
 * Wire-protocol frame schemas.
 *
 * Every WSKit wire frame is `{ event, payload, __wskit }`. `payload` is pure
 * user data; `__wskit` is framework routing and correlation metadata — the two
 * never share a namespace. Protocol events (the ones the engine itself speaks)
 * are named `__x__`. Incoming protocol frames each have a valibot schema here and
 * are parsed once at the gateway, so the dispatcher works with a discriminated
 * union instead of hand-checking wire fields at each read site. Outgoing frames
 * are not validated — the engine builds them itself — so only their event names
 * are tracked, in `OUTGOING_PROTOCOL_EVENT_NAMES`.
 */
import { WIRE_LIMITS } from '@wskit/core';
import * as v from 'valibot';

/**
 * A non-negative safe integer — sequence numbers and replay/resume cursors.
 * Bounded by `Number.MAX_SAFE_INTEGER` so a client-controlled cursor cannot
 * smuggle in a value that breaks integer math downstream.
 */
const NonNegativeSafeInt = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(0),
  v.maxValue(Number.MAX_SAFE_INTEGER),
);

/**
 * A bounded streamId — same upper limit the engine uses when generating
 * server-side ids. Echoed back in error routing and used as a SQL key, so
 * unbounded length lets a client bloat logs and storage rows.
 */
const StreamIdString = v.pipe(v.string(), v.minLength(1), v.maxLength(WIRE_LIMITS.streamId));

/**
 * Whether a stream survives a reconnect. `ephemeral` is a plain `stream` — its
 * generator dies on disconnect. `persistent` is a `resumableStream` /
 * `recordedStream` — the client auto-resumes it. Stamped on `__streamOk__` and
 * every chunk so a subscriber knows regardless of when it joined.
 */
const StreamKind = v.picklist(['ephemeral', 'persistent']);

/** The side that originated a two-way exchange, carried on `__wskit.source`. */
const Source = v.picklist(['server', 'client']);

/**
 * A bounded channel name. Channel names can be composite
 * (e.g. `org:123:room:abc`), so they get more headroom than the other
 * identifiers. The matcher runs the family regex against this value, so the cap
 * also bounds the worst-case match cost on attacker-controlled input.
 */
const ChannelName = v.pipe(v.string(), v.minLength(1), v.maxLength(WIRE_LIMITS.channel));

/**
 * A bounded family key for dynamic channels. These are short identifiers that
 * must match a declared family, so 128 is never legitimately exceeded.
 */
const ChannelFamilyKey = v.pipe(v.string(), v.minLength(1), v.maxLength(WIRE_LIMITS.channelFamily));

/**
 * A bounded correlation / message id. The client SDK stamps these as
 * UUID/ULID-shaped strings (~26-36 chars); 128 matches the streamId cap.
 * Capping stops a client bloating logs, the dedup ring, and storage rows.
 */
const WireId = v.pipe(v.string(), v.minLength(1), v.maxLength(WIRE_LIMITS.wireId));

/** A bounded user-event name. Short identifier; 128 is generous. */
const EventName = v.pipe(v.string(), v.minLength(1), v.maxLength(WIRE_LIMITS.event));

/**
 * Scope markers for a frame that must target a channel. `channelFamily` is the
 * family key for dynamic channels; wire-missing or wire-null both resolve to
 * `null`, matching the engine's "static channel = null" convention.
 */
const RequiredChannelScope = {
  channel: ChannelName,
  channelFamily: v.nullish(ChannelFamilyKey, null),
};

/**
 * Scope markers for a frame that may be top-level or channel-scoped. Every
 * field is optional; `channelFamily` still resolves to `null` when absent.
 */
const OptionalScope = {
  channel: v.optional(ChannelName),
  channelFamily: v.nullish(ChannelFamilyKey, null),
};

/**
 * Scope markers for `__replay__`. Replay stores live at two scopes — top-level
 * and channel — so only those two markers are accepted; the strict object
 * rejects any other key.
 */
const ReplayScope = {
  channel: v.optional(ChannelName),
  channelFamily: v.nullish(ChannelFamilyKey, null),
};

/** An empty payload — protocol events that carry no app data. */
const NoPayload = v.strictObject({});

export const SubscribeFrame = v.object({
  event: v.literal('__subscribe__'),
  // Loose here — the channel's `check` validator type-checks it.
  payload: v.optional(v.unknown()),
  __wskit: v.strictObject(RequiredChannelScope),
});

export const UnsubscribeFrame = v.object({
  event: v.literal('__unsubscribe__'),
  payload: NoPayload,
  // `unsubscribeId` correlates the leave with its `__unsubscribeOk__`. Optional
  // because low-level senders may leave without one; the engine only acks when
  // an id is present.
  __wskit: v.strictObject({ ...RequiredChannelScope, unsubscribeId: v.optional(WireId) }),
});

export const ReplayFrame = v.object({
  event: v.literal('__replay__'),
  payload: v.strictObject({ lastKnownSeq: v.optional(NonNegativeSafeInt) }),
  __wskit: v.strictObject(ReplayScope),
});

export const StreamCancelFrame = v.object({
  event: v.literal('__streamCancel__'),
  payload: NoPayload,
  // Scope markers let the engine find a broadcast stream's scope-keyed row.
  __wskit: v.strictObject({ ...OptionalScope, streamId: StreamIdString }),
});

export const ResumeStreamFrame = v.object({
  event: v.literal('__resumeStream__'),
  payload: v.strictObject({ lastKnownSeq: v.optional(NonNegativeSafeInt) }),
  __wskit: v.strictObject({ ...OptionalScope, streamId: StreamIdString }),
});

export const MemberSyncRequestFrame = v.object({
  event: v.literal('__memberSync__'),
  payload: v.optional(NoPayload),
  __wskit: v.strictObject({ ...RequiredChannelScope, source: v.optional(Source) }),
});

/** All frames the client may send into the engine, discriminated on `event`. */
export const IncomingProtocolFrame = v.variant('event', [
  SubscribeFrame,
  UnsubscribeFrame,
  ReplayFrame,
  StreamCancelFrame,
  ResumeStreamFrame,
  MemberSyncRequestFrame,
]);

/**
 * The loose `__wskit` block on a user-event frame. Carries the correlation id
 * for request-response flows, the routing markers for scoped sends, and the
 * dedup/sequence ids the engine stamps.
 */
export const WSKitProtocolSchema = v.strictObject({
  correlationId: v.optional(WireId),
  // The side that originated this exchange: 'server' or 'client'. One field
  // shared by every two-way flow (requests, replies, acks, subscribe). It lets
  // the receiver tell a request it must answer (the other side originated it)
  // from a reply to its own request (it originated it).
  source: v.optional(Source),
  channel: v.optional(ChannelName),
  channelFamily: v.nullish(ChannelFamilyKey, null),
  streamId: v.optional(StreamIdString),
  streamKind: v.optional(StreamKind),
  streamNudgeId: v.optional(WireId),
  streamTerminated: v.optional(v.boolean()),
  eventName: v.optional(EventName),
  messageId: v.optional(WireId),
  seq: v.optional(NonNegativeSafeInt),
});

/** Any non-protocol frame: an app event with an optional `__wskit` block. */
export const UserEventFrameSchema = v.strictObject({
  event: EventName,
  payload: v.optional(v.unknown()),
  __wskit: v.optional(WSKitProtocolSchema),
});

export type IncomingProtocolFrame = v.InferOutput<typeof IncomingProtocolFrame>;
export type WSKitProtocol = v.InferOutput<typeof WSKitProtocolSchema>;
export type UserEventFrame = v.InferOutput<typeof UserEventFrameSchema>;

/** A subset of `__wskit` markers — the routing carried on a server `__error__` frame. */
export type WSKitRouting = Partial<WSKitProtocol>;

export type SubscribeFrame = v.InferOutput<typeof SubscribeFrame>;
export type UnsubscribeFrame = v.InferOutput<typeof UnsubscribeFrame>;
export type ReplayFrame = v.InferOutput<typeof ReplayFrame>;
export type StreamCancelFrame = v.InferOutput<typeof StreamCancelFrame>;
export type ResumeStreamFrame = v.InferOutput<typeof ResumeStreamFrame>;
export type MemberSyncRequestFrame = v.InferOutput<typeof MemberSyncRequestFrame>;

/** Names of the protocol events the client may send into the engine. */
export type IncomingProtocolEvent = IncomingProtocolFrame['event'];

/**
 * True when `name` has the protocol-event shape `__x__`. The engine uses this
 * to split protocol frames (parsed against the protocol variant) from
 * user-event frames (parsed against the user-event schema) before validation.
 *
 * Plugin-owned events use the `__pluginId:event` form — they start with `__`
 * but do not end with it, so this check leaves them on the user-event path.
 */
export function isProtocolEventName(name: unknown): name is `__${string}__` {
  return (
    typeof name === 'string' && name.length > 4 && name.startsWith('__') && name.endsWith('__')
  );
}

/**
 * The exact set of protocol event names the engine itself sends to clients.
 * The engine does not validate outgoing frames, so these are listed directly
 * rather than derived from schemas. Use this — not the `__x__` shape — to decide
 * whether an outgoing event is real engine traffic, so an undeclared `__madeUp__`
 * cannot pass as a protocol frame. `protocol.spec.ts` pins this list.
 */
export const OUTGOING_PROTOCOL_EVENT_NAMES: ReadonlySet<string> = new Set([
  '__subscribeOk__',
  '__unsubscribeOk__',
  '__streamOk__',
  '__nudgeOk__',
  '__streamEnd__',
  '__error__',
  '__kicked__',
  '__memberJoin__',
  '__memberLeave__',
  '__memberOnline__',
  '__memberOffline__',
  '__memberSync__',
]);
