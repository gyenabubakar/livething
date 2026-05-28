/**
 * Wire-protocol frame schemas.
 *
 * Every wskit wire frame is `{ event, payload, __wskit }`. `payload` is pure
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
 * Scope markers for a frame that must target a channel. `channelScope` is the
 * family key for dynamic channels; wire-missing or wire-null both resolve to
 * `null`, matching the engine's "static channel = null" convention.
 */
const RequiredChannelScope = {
  channel: v.string(),
  channelScope: v.nullish(v.string(), null),
};

/**
 * Scope markers for a frame that may be top-level, namespace-, or
 * channel-scoped. Every field is optional; `channelScope` still resolves to
 * `null` when absent.
 */
const OptionalScope = {
  channel: v.optional(v.string()),
  channelScope: v.nullish(v.string(), null),
  namespace: v.optional(v.string()),
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
  __wskit: v.strictObject(OptionalScope),
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
  __wskit: v.strictObject({ ...OptionalScope, streamId: StreamIdString }),
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
export const WskitProtocolSchema = v.strictObject({
  correlationId: v.optional(v.string()),
  channel: v.optional(v.string()),
  channelScope: v.nullish(v.string(), null),
  namespace: v.optional(v.string()),
  ackId: v.optional(v.string()),
  streamId: v.optional(v.string()),
  messageId: v.optional(v.string()),
  seq: v.optional(NonNegativeSafeInt),
});

/** Any non-protocol frame: an app event with an optional `__wskit` block. */
export const UserEventFrameSchema = v.strictObject({
  event: v.string(),
  payload: v.optional(v.unknown()),
  __wskit: v.optional(WskitProtocolSchema),
});

// ───── Section: types ─────

export type IncomingProtocolFrame = v.InferOutput<typeof IncomingProtocolFrame>;
export type OutgoingProtocolFrame = v.InferOutput<typeof OutgoingProtocolFrame>;
export type WskitProtocol = v.InferOutput<typeof WskitProtocolSchema>;
export type UserEventFrame = v.InferOutput<typeof UserEventFrameSchema>;

/** A subset of `__wskit` markers — the routing carried on a server `__error__` frame. */
export type WskitRouting = Partial<WskitProtocol>;

export type SubscribeFrame = v.InferOutput<typeof SubscribeFrame>;
export type UnsubscribeFrame = v.InferOutput<typeof UnsubscribeFrame>;
export type ReplayFrame = v.InferOutput<typeof ReplayFrame>;
export type StreamCancelFrame = v.InferOutput<typeof StreamCancelFrame>;
export type ResumeStreamFrame = v.InferOutput<typeof ResumeStreamFrame>;

export type SubscribeOkFrame = v.InferOutput<typeof SubscribeOkFrame>;
export type StreamOkFrame = v.InferOutput<typeof StreamOkFrame>;
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
