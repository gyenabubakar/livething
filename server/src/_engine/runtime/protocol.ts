/**
 * Wire-protocol frame schemas.
 *
 * Every WSKit wire frame is `{ event, payload, __wskit }`. `payload` is pure
 * user data; `__wskit` is framework routing and correlation metadata — the two
 * never share a namespace. Protocol events (the ones the engine itself speaks)
 * are named `__x__` and each has its own valibot schema here.
 *
 * The incoming variants are parsed once at the gateway, so the dispatcher works
 * with a discriminated union instead of hand-checking wire fields at each read
 * site.
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

export const ReceivedFrame = v.object({
  event: v.literal('__received__'),
  payload: v.strictObject({ receivedThrough: NonNegativeSafeInt }),
  __wskit: v.strictObject(RequiredChannelScope),
});

export const ReadFrame = v.object({
  event: v.literal('__read__'),
  payload: v.strictObject({ readThrough: NonNegativeSafeInt }),
  __wskit: v.strictObject(RequiredChannelScope),
});

/**
 * The incoming half of a receipt query. The client asks who has received up to
 * `seq` on `__receivedQuery__`, or who has read up to `seq` on `__readQuery__`.
 * Each answer comes back under the same event name, paired only by
 * `correlationId` (like `__error__`).
 */
export const ReceivedQueryFrame = v.object({
  event: v.literal('__receivedQuery__'),
  payload: v.strictObject({ seq: NonNegativeSafeInt }),
  __wskit: v.strictObject({ ...RequiredChannelScope, correlationId: WireId }),
});

export const ReadQueryFrame = v.object({
  event: v.literal('__readQuery__'),
  payload: v.strictObject({ seq: NonNegativeSafeInt }),
  __wskit: v.strictObject({ ...RequiredChannelScope, correlationId: WireId }),
});

/** All frames the client may send into the engine, discriminated on `event`. */
export const IncomingProtocolFrame = v.variant('event', [
  SubscribeFrame,
  UnsubscribeFrame,
  ReplayFrame,
  StreamCancelFrame,
  ResumeStreamFrame,
  MemberSyncRequestFrame,
  ReceivedFrame,
  ReadFrame,
  ReceivedQueryFrame,
  ReadQueryFrame,
]);

export const SubscribeOkFrame = v.object({
  event: v.literal('__subscribeOk__'),
  payload: NoPayload,
  // `source` is who initiated the subscribe: 'client' (the client's own
  // subscribe call, so it resolves that pending promise) or 'server' (the server
  // subscribed it, so there is no client promise to settle). `channelMembership`
  // tells the client whether this channel auto-rejoins on reconnect ('persistent',
  // server-driven) or not ('ephemeral') so it knows not to re-subscribe it itself.
  // `inbox` marks a channel whose delivery is inbox-backed, so the client acks
  // only these with `__received__` and stays quiet on the rest.
  __wskit: v.strictObject({
    ...RequiredChannelScope,
    source: Source,
    channelMembership: v.picklist(['persistent', 'ephemeral']),
    inbox: v.optional(v.boolean()),
    readReceipts: v.optional(v.boolean()),
  }),
});

export const UnsubscribeOkFrame = v.object({
  event: v.literal('__unsubscribeOk__'),
  payload: NoPayload,
  // Echoes the leave's `unsubscribeId` so the client settles the exact pending
  // leave op — never a stale one from an earlier connection.
  __wskit: v.strictObject({ ...RequiredChannelScope, unsubscribeId: WireId }),
});

export const StreamOkFrame = v.object({
  event: v.literal('__streamOk__'),
  payload: NoPayload,
  __wskit: v.strictObject({ ...OptionalScope, streamId: StreamIdString, streamKind: StreamKind }),
});

export const NudgeOkFrame = v.object({
  event: v.literal('__nudgeOk__'),
  payload: NoPayload,
  __wskit: v.strictObject({ ...OptionalScope, streamId: StreamIdString, streamNudgeId: WireId }),
});

export const StreamEndFrame = v.object({
  event: v.literal('__streamEnd__'),
  payload: NoPayload,
  // `seq` is the final sequence number, so the client can check for missed chunks.
  // `eventName` is the stream's declared event, carried on a broadcast fan-out so a
  // listen-only subscriber can route this terminal frame (its `event` is the protocol name).
  __wskit: v.strictObject({
    ...OptionalScope,
    streamId: StreamIdString,
    seq: v.optional(NonNegativeSafeInt),
    eventName: v.optional(EventName),
  }),
});

export const ErrorFrame = v.object({
  event: v.literal('__error__'),
  payload: v.strictObject({
    code: v.string(),
    detail: v.optional(v.unknown()),
  }),
  __wskit: v.strictObject({
    ...OptionalScope,
    correlationId: v.optional(v.string()),
    source: v.optional(Source),
    streamId: v.optional(v.string()),
    streamNudgeId: v.optional(v.string()),
    // On a stream error: true ends the stream, false (e.g. a rejected nudge) leaves it running.
    streamTerminated: v.optional(v.boolean()),
    // The stream's declared event, carried on a broadcast error fan-out so a
    // listen-only subscriber can route this terminal frame.
    eventName: v.optional(EventName),
  }),
});

export const KickedFrame = v.object({
  event: v.literal('__kicked__'),
  payload: v.strictObject({ reason: v.string() }),
  __wskit: v.strictObject(RequiredChannelScope),
});

export const MemberJoinFrame = v.object({
  event: v.literal('__memberJoin__'),
  payload: v.strictObject({
    connectionId: v.string(),
    meta: v.optional(v.record(v.string(), v.unknown())),
  }),
  __wskit: v.strictObject(RequiredChannelScope),
});

export const MemberLeaveFrame = v.object({
  event: v.literal('__memberLeave__'),
  payload: v.strictObject({
    connectionId: v.string(),
    meta: v.optional(v.record(v.string(), v.unknown())),
  }),
  __wskit: v.strictObject(RequiredChannelScope),
});

export const MemberOnlineFrame = v.object({
  event: v.literal('__memberOnline__'),
  payload: v.strictObject({
    connectionId: v.string(),
    meta: v.optional(v.record(v.string(), v.unknown())),
  }),
  __wskit: v.strictObject(RequiredChannelScope),
});

export const MemberOfflineFrame = v.object({
  event: v.literal('__memberOffline__'),
  payload: v.strictObject({ connectionId: v.string() }),
  __wskit: v.strictObject(RequiredChannelScope),
});

// The whole current member list, sent once right after __subscribeOk__ in
// place of a per-member __memberJoin__ / __memberOnline__ initial batch.
export const MemberSyncFrame = v.object({
  event: v.literal('__memberSync__'),
  payload: v.strictObject({
    members: v.array(
      v.strictObject({
        connectionId: v.string(),
        meta: v.optional(v.record(v.string(), v.unknown())),
      }),
    ),
  }),
  __wskit: v.strictObject({ ...RequiredChannelScope, source: v.optional(Source) }),
});

export const ReceivedFanoutFrame = v.object({
  event: v.literal('__received__'),
  payload: v.strictObject({ userId: v.string(), receivedThrough: NonNegativeSafeInt }),
  __wskit: v.strictObject(RequiredChannelScope),
});

export const ReadFanoutFrame = v.object({
  event: v.literal('__read__'),
  payload: v.strictObject({ userId: v.string(), readThrough: NonNegativeSafeInt }),
  __wskit: v.strictObject(RequiredChannelScope),
});

/**
 * The outgoing half of a receipt query. Shares its event name with the incoming
 * request (`__receivedQuery__` / `__readQuery__`) and echoes its `correlationId`;
 * the client pairs the two by correlation id alone, exactly as `__error__` does.
 */
export const ReceivedQueryResultFrame = v.object({
  event: v.literal('__receivedQuery__'),
  payload: v.strictObject({ userIds: v.array(v.string()) }),
  __wskit: v.strictObject({ ...RequiredChannelScope, correlationId: WireId }),
});

export const ReadQueryResultFrame = v.object({
  event: v.literal('__readQuery__'),
  payload: v.strictObject({ userIds: v.array(v.string()) }),
  __wskit: v.strictObject({ ...RequiredChannelScope, correlationId: WireId }),
});

export const GapFrame = v.object({
  event: v.literal('__gap__'),
  // `missedThrough` is the highest seq the server pruned for this scope; below it, a client missed at least up to it.
  payload: v.strictObject({ missedThrough: NonNegativeSafeInt }),
  __wskit: v.strictObject(ReplayScope),
});

/** All frames the engine sends to clients, discriminated on `event`. */
export const OutgoingProtocolFrame = v.variant('event', [
  SubscribeOkFrame,
  UnsubscribeOkFrame,
  StreamOkFrame,
  NudgeOkFrame,
  StreamEndFrame,
  ErrorFrame,
  KickedFrame,
  MemberJoinFrame,
  MemberLeaveFrame,
  MemberOnlineFrame,
  MemberOfflineFrame,
  MemberSyncFrame,
  ReceivedFanoutFrame,
  ReadFanoutFrame,
  ReceivedQueryResultFrame,
  ReadQueryResultFrame,
  GapFrame,
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

const WSKIT_KEYS = new Set(Object.keys(WSKitProtocolSchema.entries));

// The `__wskit` fields that are a bounded string, with each field's length cap.
const WIRE_STRING_FIELDS: ReadonlyArray<[keyof WSKitProtocol, number]> = [
  ['correlationId', WIRE_LIMITS.wireId],
  ['channel', WIRE_LIMITS.channel],
  ['streamId', WIRE_LIMITS.streamId],
  ['streamNudgeId', WIRE_LIMITS.wireId],
  ['eventName', WIRE_LIMITS.event],
  ['messageId', WIRE_LIMITS.wireId],
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function withinWireLimit(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= max;
}

/**
 * Validate a user-event frame directly, skipping valibot's per-field walk on the
 * hot path. Returns the parsed frame, or `null` when the frame deviates in any
 * way — the caller falls back to `v.parse(UserEventFrameSchema, …)` to raise the
 * exact ValiError. Mirrors {@link WSKitProtocolSchema} exactly: the same
 * wire-limit bounds, the `channelFamily` null default, and strict rejection of
 * unknown keys.
 */
function fastParseUserEventFrame(input: unknown): UserEventFrame | null {
  if (!isRecord(input)) return null;

  for (const key in input) {
    if (key !== 'event' && key !== 'payload' && key !== '__wskit') return null;
  }

  if (!withinWireLimit(input.event, WIRE_LIMITS.event)) return null;

  if (input.__wskit === undefined) return { event: input.event, payload: input.payload };

  const wskit = fastParseWSKit(input.__wskit);
  if (wskit === null) return null;

  return { event: input.event, payload: input.payload, __wskit: wskit };
}

function parseSource(input: Record<string, unknown>, out: WSKitProtocol): boolean {
  if (input.source === undefined) return true;

  if (input.source !== 'server' && input.source !== 'client') return false;

  out.source = input.source;
  return true;
}

function parseStreamKind(input: Record<string, unknown>, out: WSKitProtocol): boolean {
  if (input.streamKind === undefined) return true;

  if (input.streamKind !== 'ephemeral' && input.streamKind !== 'persistent') return false;

  out.streamKind = input.streamKind;
  return true;
}

function parseStreamTerminated(input: Record<string, unknown>, out: WSKitProtocol): boolean {
  if (input.streamTerminated === undefined) return true;

  if (typeof input.streamTerminated !== 'boolean') return false;

  out.streamTerminated = input.streamTerminated;
  return true;
}

function parseSequence(input: Record<string, unknown>, out: WSKitProtocol): boolean {
  if (input.seq === undefined) return true;

  const seq = input.seq;
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0 || seq > Number.MAX_SAFE_INTEGER)
    return false;

  out.seq = seq;

  return true;
}

function parseChannelFamily(input: Record<string, unknown>, out: WSKitProtocol): boolean {
  if (input.channelFamily === undefined || input.channelFamily === null) return true;

  if (!withinWireLimit(input.channelFamily, WIRE_LIMITS.channelFamily)) return false;

  out.channelFamily = input.channelFamily;
  return true;
}

function fastParseWSKit(input: unknown): WSKitProtocol | null {
  if (!isRecord(input)) return null;

  for (const key in input) {
    if (!WSKIT_KEYS.has(key)) return null;
  }

  // `channelFamily` is nullish (always present, defaulting to null); the rest are
  // optional and added only when the frame carries them.
  const out: WSKitProtocol = { channelFamily: null };

  for (const [key, max] of WIRE_STRING_FIELDS) {
    const value = input[key];
    if (value === undefined) continue;

    if (!withinWireLimit(value, max)) return null;

    (out as Record<string, unknown>)[key] = value;
  }

  if (!parseSource(input, out)) return null;

  if (!parseStreamKind(input, out)) return null;

  if (!parseStreamTerminated(input, out)) return null;

  if (!parseSequence(input, out)) return null;

  if (!parseChannelFamily(input, out)) return null;

  return out;
}

/**
 * Parse a user-event frame off the wire. Tries the direct validator first and
 * falls back to valibot only when a frame is malformed, so an invalid frame
 * still throws the same detailed `ValiError`.
 */
export function parseUserEventFrame(input: unknown): UserEventFrame {
  return fastParseUserEventFrame(input) ?? v.parse(UserEventFrameSchema, input);
}

export type IncomingProtocolFrame = v.InferOutput<typeof IncomingProtocolFrame>;
export type OutgoingProtocolFrame = v.InferOutput<typeof OutgoingProtocolFrame>;
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
export type ReceivedFrame = v.InferOutput<typeof ReceivedFrame>;
export type ReadFrame = v.InferOutput<typeof ReadFrame>;
export type ReceivedQueryFrame = v.InferOutput<typeof ReceivedQueryFrame>;
export type ReadQueryFrame = v.InferOutput<typeof ReadQueryFrame>;

export type SubscribeOkFrame = v.InferOutput<typeof SubscribeOkFrame>;
export type UnsubscribeOkFrame = v.InferOutput<typeof UnsubscribeOkFrame>;
export type StreamOkFrame = v.InferOutput<typeof StreamOkFrame>;
export type NudgeOkFrame = v.InferOutput<typeof NudgeOkFrame>;
export type StreamEndFrame = v.InferOutput<typeof StreamEndFrame>;
export type ErrorFrame = v.InferOutput<typeof ErrorFrame>;
export type KickedFrame = v.InferOutput<typeof KickedFrame>;
export type MemberJoinFrame = v.InferOutput<typeof MemberJoinFrame>;
export type MemberLeaveFrame = v.InferOutput<typeof MemberLeaveFrame>;
export type MemberOnlineFrame = v.InferOutput<typeof MemberOnlineFrame>;
export type MemberOfflineFrame = v.InferOutput<typeof MemberOfflineFrame>;
export type MemberSyncFrame = v.InferOutput<typeof MemberSyncFrame>;
export type ReceivedFanoutFrame = v.InferOutput<typeof ReceivedFanoutFrame>;
export type ReadFanoutFrame = v.InferOutput<typeof ReadFanoutFrame>;
export type ReceivedQueryResultFrame = v.InferOutput<typeof ReceivedQueryResultFrame>;
export type ReadQueryResultFrame = v.InferOutput<typeof ReadQueryResultFrame>;
export type GapFrame = v.InferOutput<typeof GapFrame>;

/** Names of the protocol events the client may send into the engine. */
export type IncomingProtocolEvent = IncomingProtocolFrame['event'];
/** Names of the protocol events the engine sends to clients. */
export type OutgoingProtocolEvent = OutgoingProtocolFrame['event'];

/**
 * True when `name` has the protocol-event shape `__x__`.
 */
export function isProtocolEventName(name: unknown): name is `__${string}__` {
  return (
    typeof name === 'string' && name.length > 4 && name.startsWith('__') && name.endsWith('__')
  );
}

/** Pull the `event` literal out of each option of a protocol variant schema. */
function collectVariantEventNames(variant: typeof OutgoingProtocolFrame): string[] {
  const names: string[] = [];
  for (const option of variant.options) {
    const eventSchema = option.entries.event;
    if (eventSchema.type === 'literal' && typeof eventSchema.literal === 'string') {
      names.push(eventSchema.literal);
    }
  }

  return names;
}

/**
 * The exact set of protocol event names the engine itself sends to clients,
 * built from the outgoing protocol frame schemas. Use this — not the `__x__`
 * shape — to decide whether an outgoing event is real engine traffic, so an
 * undeclared `__madeUp__` cannot pass as a protocol frame.
 */
export const OUTGOING_PROTOCOL_EVENT_NAMES: ReadonlySet<string> = new Set(
  collectVariantEventNames(OutgoingProtocolFrame),
);
