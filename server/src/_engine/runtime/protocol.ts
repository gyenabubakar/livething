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
import * as v from 'valibot';

// ───── Section: reusable pieces ─────

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
const StreamIdString = v.pipe(v.string(), v.minLength(1), v.maxLength(128));

/**
 * Whether a stream survives a reconnect. `ephemeral` is a plain `stream` — its
 * generator dies on disconnect. `persistent` is a `resumableStream` /
 * `recordedStream` — the client auto-resumes it. Stamped on `__streamOk__` and
 * every chunk so a subscriber knows regardless of when it joined.
 */
const StreamKind = v.picklist(['ephemeral', 'persistent']);

/**
 * A bounded channel name. Channel names can be composite
 * (e.g. `org:123:room:abc`), so they get more headroom than the other
 * identifiers. The matcher runs the family regex against this value, so the cap
 * also bounds the worst-case match cost on attacker-controlled input.
 */
const ChannelName = v.pipe(v.string(), v.minLength(1), v.maxLength(256));

/**
 * A bounded family key / namespace name. These are short identifiers that must
 * match a declared scope, so 128 is never legitimately exceeded.
 */
const ScopeKey = v.pipe(v.string(), v.maxLength(128));

/**
 * A bounded correlation / ack / message id. The client SDK stamps these as
 * UUID/ULID-shaped strings (~26-36 chars); 128 matches the streamId cap.
 * Capping stops a client bloating logs, the dedup ring, and storage rows.
 */
const WireId = v.pipe(v.string(), v.minLength(1), v.maxLength(128));

/** A bounded user-event name. Short identifier; 128 is generous. */
const EventName = v.pipe(v.string(), v.minLength(1), v.maxLength(128));

/**
 * Scope markers for a frame that must target a channel. `channelScope` is the
 * family key for dynamic channels; wire-missing or wire-null both resolve to
 * `null`, matching the engine's "static channel = null" convention.
 */
const RequiredChannelScope = {
  channel: ChannelName,
  channelScope: v.nullish(ScopeKey, null),
};

/**
 * Scope markers for a frame that may be top-level, namespace-, or
 * channel-scoped. Every field is optional; `channelScope` still resolves to
 * `null` when absent.
 */
const OptionalScope = {
  channel: v.optional(ChannelName),
  channelScope: v.nullish(ScopeKey, null),
  namespace: v.optional(ScopeKey),
};

/**
 * Scope markers for `__replay__`. Replay stores live at two scopes — top-level
 * and channel — so there is no `namespace` marker: a namespace is a scope but
 * has no replay store of its own, so its messages come back as part of a
 * top-level replay. The strict object rejects a stray `namespace`.
 */
const ReplayScope = {
  channel: v.optional(ChannelName),
  channelScope: v.nullish(ScopeKey, null),
};

/** An empty payload — protocol events that carry no app data. */
const NoPayload = v.strictObject({});

// ───── Section: incoming protocol frames (client → server) ─────

export const SubscribeFrame = v.object({
  event: v.literal('__subscribe__'),
  // Loose here — the channel's `check` validator type-checks it.
  payload: v.optional(v.unknown()),
  __wskit: v.strictObject(RequiredChannelScope),
});

export const UnsubscribeFrame = v.object({
  event: v.literal('__unsubscribe__'),
  payload: NoPayload,
  __wskit: v.strictObject(RequiredChannelScope),
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

/** All frames the client may send into the engine, discriminated on `event`. */
export const IncomingProtocolFrame = v.variant('event', [
  SubscribeFrame,
  UnsubscribeFrame,
  ReplayFrame,
  StreamCancelFrame,
  ResumeStreamFrame,
]);

// ───── Section: outgoing protocol frames (server → client) ─────

export const SubscribeOkFrame = v.object({
  event: v.literal('__subscribeOk__'),
  payload: v.strictObject({ source: v.picklist(['client', 'server']) }),
  __wskit: v.strictObject(RequiredChannelScope),
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
  __wskit: v.strictObject({
    ...OptionalScope,
    streamId: StreamIdString,
    seq: v.optional(NonNegativeSafeInt),
  }),
});

export const AckFrame = v.object({
  event: v.literal('__ack__'),
  payload: NoPayload,
  __wskit: v.strictObject({ ackId: v.string() }),
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
    ackId: v.optional(v.string()),
    streamId: v.optional(v.string()),
    streamNudgeId: v.optional(v.string()),
    // On a stream error: true ends the stream, false (e.g. a rejected nudge) leaves it running.
    streamTerminated: v.optional(v.boolean()),
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
  __wskit: v.strictObject(RequiredChannelScope),
});

/** All frames the engine sends to clients, discriminated on `event`. */
export const OutgoingProtocolFrame = v.variant('event', [
  SubscribeOkFrame,
  StreamOkFrame,
  NudgeOkFrame,
  StreamEndFrame,
  AckFrame,
  ErrorFrame,
  KickedFrame,
  MemberJoinFrame,
  MemberLeaveFrame,
  MemberOnlineFrame,
  MemberOfflineFrame,
  MemberSyncFrame,
]);

// ───── Section: user-event frames ─────

/**
 * The loose `__wskit` block on a user-event frame. Carries the correlation and
 * ack ids for request-response and delivery-confirmation flows, the routing
 * markers for scoped sends, and the dedup/sequence ids the engine stamps.
 */
export const WSKitProtocolSchema = v.strictObject({
  correlationId: v.optional(WireId),
  channel: v.optional(ChannelName),
  channelScope: v.nullish(ScopeKey, null),
  namespace: v.optional(ScopeKey),
  ackId: v.optional(WireId),
  streamId: v.optional(StreamIdString),
  streamKind: v.optional(StreamKind),
  streamNudgeId: v.optional(WireId),
  streamTerminated: v.optional(v.boolean()),
  messageId: v.optional(WireId),
  seq: v.optional(NonNegativeSafeInt),
});

/** Any non-protocol frame: an app event with an optional `__wskit` block. */
export const UserEventFrameSchema = v.strictObject({
  event: EventName,
  payload: v.optional(v.unknown()),
  __wskit: v.optional(WSKitProtocolSchema),
});

// ───── Section: types ─────

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

export type SubscribeOkFrame = v.InferOutput<typeof SubscribeOkFrame>;
export type StreamOkFrame = v.InferOutput<typeof StreamOkFrame>;
export type NudgeOkFrame = v.InferOutput<typeof NudgeOkFrame>;
export type StreamEndFrame = v.InferOutput<typeof StreamEndFrame>;
export type AckFrame = v.InferOutput<typeof AckFrame>;
export type ErrorFrame = v.InferOutput<typeof ErrorFrame>;
export type KickedFrame = v.InferOutput<typeof KickedFrame>;
export type MemberJoinFrame = v.InferOutput<typeof MemberJoinFrame>;
export type MemberLeaveFrame = v.InferOutput<typeof MemberLeaveFrame>;
export type MemberOnlineFrame = v.InferOutput<typeof MemberOnlineFrame>;
export type MemberOfflineFrame = v.InferOutput<typeof MemberOfflineFrame>;
export type MemberSyncFrame = v.InferOutput<typeof MemberSyncFrame>;

/** Names of the protocol events the client may send into the engine. */
export type IncomingProtocolEvent = IncomingProtocolFrame['event'];
/** Names of the protocol events the engine sends to clients. */
export type OutgoingProtocolEvent = OutgoingProtocolFrame['event'];

// ───── Section: dispatch helper ─────

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
