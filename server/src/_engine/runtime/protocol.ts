/** The LiveThing wire protocol. Frames are always [event, payload, metadata]. */
import { WIRE_LIMITS } from '@livething/core';
import * as v from 'valibot';

const NonNegativeSafeInt = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(0),
  v.maxValue(Number.MAX_SAFE_INTEGER),
);
function StringLimit(limit: number) {
  return v.pipe(v.string(), v.minLength(1), v.maxLength(limit));
}

const EventName = StringLimit(WIRE_LIMITS.event);
const WireId = StringLimit(WIRE_LIMITS.wireId);
const StreamId = StringLimit(WIRE_LIMITS.streamId);
const ChannelName = StringLimit(WIRE_LIMITS.channel);
const ChannelFamily = StringLimit(WIRE_LIMITS.channelFamily);
const Source = v.picklist(['server', 'client']);
const Durability = v.picklist(['ephemeral', 'persistent']);

/** Internal routing shape. It is normalized from/to the nested wire metadata. */
export interface LiveThingProtocol {
  correlationId?: string;
  source?: 'server' | 'client';
  channel?: string;
  channelFamily: string | null;
  unsubscribeId?: string;
  channelMembership?: 'persistent' | 'ephemeral';
  inbox?: boolean;
  readReceipts?: boolean;
  streamId?: string;
  streamDurability?: 'ephemeral' | 'persistent';
  streamNudgeId?: string;
  streamTerminated?: boolean;
  eventName?: string;
  messageId?: string;
  deliverySeq?: number;
  streamSeq?: number;
  uploadId?: string;
  uploadSeq?: number;
  uploadSize?: number;
}

export interface ProtocolFrame {
  event: string;
  payload: unknown;
  __livething: LiveThingProtocol;
}

const ExchangeMetadata = v.pipe(
  v.strictObject({ id: v.optional(WireId), source: v.optional(Source) }),
  v.check((value) => Object.keys(value).length > 0),
);
const ChannelMetadata = v.strictObject(
  {
    name: ChannelName,
    family: v.optional(ChannelFamily),
    unsubscribeId: v.optional(WireId),
    membership: v.optional(v.picklist(['persistent', 'ephemeral'])),
    inbox: v.optional(v.boolean()),
    readReceipts: v.optional(v.boolean()),
  },
  "The 'channel' metadata must be an object with a 'name'.",
);
const DeliveryMetadata = v.pipe(
  v.strictObject({ id: v.optional(WireId), seq: v.optional(NonNegativeSafeInt) }),
  v.check((value) => Object.keys(value).length > 0),
);
const StreamMetadata = v.strictObject({
  id: StreamId,
  event: v.optional(EventName),
  durability: v.optional(Durability),
  seq: v.optional(NonNegativeSafeInt),
  nudgeId: v.optional(WireId),
  terminated: v.optional(v.boolean()),
});

const UploadMetadata = v.pipe(
  v.strictObject({
    id: WireId,
    seq: v.optional(NonNegativeSafeInt),
    size: v.optional(NonNegativeSafeInt),
  }),
  v.check(
    (value) => value.seq === undefined || value.size === undefined,
    "The 'upload' metadata carries a 'seq' or a 'size', not both.",
  ),
);

/** The metadata shape accepted on the wire. Unknown groups and top-level fields reject. */
const MetadataObjectSchema = v.strictObject({
  exchange: v.optional(ExchangeMetadata),
  channel: v.optional(ChannelMetadata),
  delivery: v.optional(DeliveryMetadata),
  stream: v.optional(StreamMetadata),
  upload: v.optional(UploadMetadata),
});
export const MetadataSchema = v.pipe(
  MetadataObjectSchema,
  v.check((value) => Object.keys(value).length > 0),
);
const Metadata = v.nullable(MetadataSchema);
const NoPayload = v.null();

function metadataToLiveThing(input: unknown): LiveThingProtocol {
  const out: LiveThingProtocol = { channelFamily: null };
  if (input === null) return out;

  const metadata = input as {
    exchange?: { id?: string; source?: 'server' | 'client' };
    channel?: {
      name: string;
      family?: string | null;
      unsubscribeId?: string;
      membership?: 'persistent' | 'ephemeral';
      inbox?: boolean;
      readReceipts?: boolean;
    };
    delivery?: { id?: string; seq?: number };
    stream?: {
      id: string;
      event?: string;
      durability?: 'ephemeral' | 'persistent';
      seq?: number;
      nudgeId?: string;
      terminated?: boolean;
    };
    upload?: { id: string; seq?: number; size?: number };
  };
  if (metadata.exchange) {
    if (metadata.exchange.id !== undefined) out.correlationId = metadata.exchange.id;
    if (metadata.exchange.source !== undefined) out.source = metadata.exchange.source;
  }

  if (metadata.channel) {
    out.channel = metadata.channel.name;
    out.channelFamily = metadata.channel.family ?? null;
    if (metadata.channel.unsubscribeId !== undefined) {
      out.unsubscribeId = metadata.channel.unsubscribeId;
    }

    if (metadata.channel.membership !== undefined) {
      out.channelMembership = metadata.channel.membership;
    }

    if (metadata.channel.inbox !== undefined) out.inbox = metadata.channel.inbox;
    if (metadata.channel.readReceipts !== undefined) {
      out.readReceipts = metadata.channel.readReceipts;
    }
  }

  if (metadata.delivery) {
    if (metadata.delivery.id !== undefined) out.messageId = metadata.delivery.id;
    if (metadata.delivery.seq !== undefined) out.deliverySeq = metadata.delivery.seq;
  }

  if (metadata.stream) {
    out.streamId = metadata.stream.id;
    if (metadata.stream.event !== undefined) out.eventName = metadata.stream.event;
    if (metadata.stream.durability !== undefined) out.streamDurability = metadata.stream.durability;
    if (metadata.stream.seq !== undefined) out.streamSeq = metadata.stream.seq;

    if (metadata.stream.nudgeId !== undefined) out.streamNudgeId = metadata.stream.nudgeId;
    if (metadata.stream.terminated !== undefined) out.streamTerminated = metadata.stream.terminated;
  }

  if (metadata.upload) {
    out.uploadId = metadata.upload.id;
    if (metadata.upload.seq !== undefined) out.uploadSeq = metadata.upload.seq;
    if (metadata.upload.size !== undefined) out.uploadSize = metadata.upload.size;
  }

  return out;
}

export { metadataFromLiveThing, serializeWireFrame } from './wire-serialize.ts';

type MetadataObject = v.InferOutput<typeof MetadataObjectSchema>;
type MetadataWithGroups<Groups extends keyof MetadataObject> = MetadataObject &
  Required<Pick<MetadataObject, Groups>>;

type RoutingForMetadata<Metadata> = Metadata extends { channel: { name: string } }
  ? LiveThingProtocol & { channel: string }
  : Metadata extends { stream: { id: string } }
    ? LiveThingProtocol & { streamId: string }
    : LiveThingProtocol;

type FrameOutput<Event extends string, Payload, Metadata> = {
  event: Event;
  payload: Payload;
  __livething: RoutingForMetadata<Metadata>;
};

function frame<
  Event extends string,
  PayloadSchema extends v.GenericSchema,
  MetadataSchema extends v.GenericSchema,
>(
  event: Event,
  payload: PayloadSchema,
  metadata: MetadataSchema,
): v.GenericSchema<
  unknown,
  FrameOutput<Event, v.InferOutput<PayloadSchema>, v.InferOutput<MetadataSchema>>
> {
  return v.pipe(
    v.strictTuple([v.literal(event), payload, metadata]),
    v.transform((tuple) => {
      const [name, body, routing] = tuple;
      return {
        event: name,
        payload: body,
        __livething: metadataToLiveThing(routing),
      };
    }),
  ) as unknown as v.GenericSchema<
    unknown,
    FrameOutput<Event, v.InferOutput<PayloadSchema>, v.InferOutput<MetadataSchema>>
  >;
}

function requiredMetadata<Groups extends keyof MetadataObject>(
  group: Groups,
): v.GenericSchema<unknown, MetadataWithGroups<Groups>> {
  return v.pipe(
    Metadata,
    v.check((value) => value !== null && group in value, `This frame needs '${group}' metadata.`),
  ) as unknown as v.GenericSchema<unknown, MetadataWithGroups<Groups>>;
}

const channelMeta = requiredMetadata('channel');
const exchangeMeta = requiredMetadata('exchange');
const streamMeta = requiredMetadata('stream');
const uploadMeta = requiredMetadata('upload');
const queryMeta = v.pipe(
  exchangeMeta,
  v.check((value) => value !== null && 'channel' in value, "This frame needs 'channel' metadata."),
) as v.GenericSchema<unknown, MetadataWithGroups<'exchange' | 'channel'>>;

export const SubscribeFrame = frame('__subscribe__', v.unknown(), channelMeta);
export const UnsubscribeFrame = frame('__unsubscribe__', NoPayload, channelMeta);
/** How many resume tokens one `__replay__` may show: the client keeps its last few connections'. */
export const MAX_RESUME_TOKENS = 8;
const ResumeToken = v.pipe(v.string(), v.minLength(1), v.maxLength(64));
export const ReplayFrame = frame(
  '__replay__',
  v.strictObject({
    lastKnownSeq: v.optional(NonNegativeSafeInt),
    resume: v.optional(v.pipe(v.array(ResumeToken), v.maxLength(MAX_RESUME_TOKENS))),
  }),
  Metadata,
);
export const StreamCancelFrame = frame('__streamCancel__', NoPayload, streamMeta);
export const ContinueStreamFrame = frame(
  '__continueStream__',
  v.strictObject({ lastKnownSeq: v.optional(NonNegativeSafeInt) }),
  streamMeta,
);
const ReceivedFrame = frame(
  '__received__',
  v.strictObject({ receivedThrough: NonNegativeSafeInt }),
  channelMeta,
);
export const ReadFrame = frame(
  '__read__',
  v.strictObject({ readThrough: NonNegativeSafeInt }),
  channelMeta,
);
const ReceivedQueryFrame = frame(
  '__receivedQuery__',
  v.strictObject({ seq: NonNegativeSafeInt }),
  queryMeta,
);
const ReadQueryFrame = frame(
  '__readQuery__',
  v.strictObject({ seq: NonNegativeSafeInt }),
  queryMeta,
);
export const UploadEndFrame = frame(
  '__uploadEnd__',
  v.strictObject({ totalBytes: NonNegativeSafeInt }),
  uploadMeta,
);
export const UploadCancelFrame = frame('__uploadCancel__', NoPayload, uploadMeta);

/** Whether a parsed frame is a well-formed `__uploadCancel__`, the same check its handler runs. */
export function isUploadCancelFrame(input: unknown): boolean {
  return v.is(UploadCancelFrame, input);
}

const INCOMING_FRAMES = {
  __subscribe__: SubscribeFrame,
  __unsubscribe__: UnsubscribeFrame,
  __replay__: ReplayFrame,
  __streamCancel__: StreamCancelFrame,
  __continueStream__: ContinueStreamFrame,
  __received__: ReceivedFrame,
  __read__: ReadFrame,
  __receivedQuery__: ReceivedQueryFrame,
  __readQuery__: ReadQueryFrame,
  __uploadEnd__: UploadEndFrame,
  __uploadCancel__: UploadCancelFrame,
};

export const IncomingProtocolFrame = v.union(Object.values(INCOMING_FRAMES));

/**
 * Parse an incoming protocol frame with the schema of the event it names, so an
 * issue says what is wrong with that frame, not that no frame of the union fits.
 */
export function parseIncomingProtocolFrame(input: unknown): IncomingProtocolFrame {
  const event = Array.isArray(input) ? (input[0] as unknown) : undefined;
  if (typeof event === 'string' && Object.hasOwn(INCOMING_FRAMES, event)) {
    return v.parse(
      INCOMING_FRAMES[event as keyof typeof INCOMING_FRAMES] as v.GenericSchema<
        unknown,
        IncomingProtocolFrame
      >,
      input,
    );
  }

  return v.parse(
    v.custom<IncomingProtocolFrame>(() => false, 'This is not a known protocol frame.'),
    input,
  );
}

export const SubscribeOkFrame = frame(
  '__subscribeOk__',
  v.nullable(v.strictObject({ seq: NonNegativeSafeInt })),
  channelMeta,
);
const UnsubscribeOkFrame = frame('__unsubscribeOk__', NoPayload, channelMeta);
const StreamOkFrame = frame('__streamOk__', NoPayload, streamMeta);
const NudgeOkFrame = frame('__nudgeOk__', NoPayload, streamMeta);
const StreamEndFrame = frame('__streamEnd__', NoPayload, streamMeta);
const ErrorFrame = frame(
  '__error__',
  v.strictObject({ code: v.string(), detail: v.optional(v.unknown()) }),
  Metadata,
);
const KickedFrame = frame('__kicked__', v.strictObject({ reason: v.string() }), channelMeta);
/**
 * `memberId` is the user id on a persistent channel (stable across reconnects
 * and tabs) and the connection id on an ephemeral channel or for an anonymous
 * connection.
 */
const MemberPayload = v.strictObject({
  memberId: v.string(),
  meta: v.optional(v.record(v.string(), v.unknown())),
});
const MemberJoinFrame = frame('__memberJoin__', MemberPayload, channelMeta);
const MemberLeaveFrame = frame('__memberLeave__', MemberPayload, channelMeta);
const MemberOnlineFrame = frame('__memberOnline__', MemberPayload, channelMeta);
const MemberOfflineFrame = frame(
  '__memberOffline__',
  v.strictObject({ memberId: v.string() }),
  channelMeta,
);
/**
 * One roster entry. `online` is `false` for a member of a persistent channel
 * that has no live connection right now.
 */
const SyncMemberPayload = v.strictObject({
  memberId: v.string(),
  meta: v.optional(v.record(v.string(), v.unknown())),
  online: v.boolean(),
});
const MemberSyncFrame = frame(
  '__memberSync__',
  v.strictObject({ members: v.array(SyncMemberPayload) }),
  channelMeta,
);
const ReceivedFanoutFrame = frame(
  '__received__',
  v.strictObject({ userId: v.string(), receivedThrough: NonNegativeSafeInt }),
  channelMeta,
);
const ReadFanoutFrame = frame(
  '__read__',
  v.strictObject({ userId: v.string(), readThrough: NonNegativeSafeInt }),
  channelMeta,
);
const ReceivedQueryResultFrame = frame(
  '__receivedQuery__',
  v.strictObject({ userIds: v.array(v.string()) }),
  queryMeta,
);
const ReadQueryResultFrame = frame(
  '__readQuery__',
  v.strictObject({ userIds: v.array(v.string()) }),
  queryMeta,
);
const GapFrame = frame('__gap__', v.strictObject({ missedThrough: NonNegativeSafeInt }), Metadata);
const ResumeFrame = frame(
  '__resume__',
  v.strictObject({ token: ResumeToken, seq: v.optional(NonNegativeSafeInt) }),
  Metadata,
);
const UploadAckFrame = frame(
  '__uploadAck__',
  v.strictObject({
    receivedThrough: NonNegativeSafeInt,
    savedThrough: NonNegativeSafeInt,
    pieceBytes: v.optional(NonNegativeSafeInt),
    windowBytes: v.optional(NonNegativeSafeInt),
  }),
  uploadMeta,
);
const UploadDoneFrame = frame('__uploadDone__', v.unknown(), uploadMeta);
export const OutgoingProtocolFrame = v.union([
  UploadAckFrame,
  UploadDoneFrame,
  ResumeFrame,
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

const UserEventWireFrame = v.strictTuple([EventName, v.unknown(), Metadata]);
export const UserEventFrameSchema = v.pipe(
  UserEventWireFrame,
  v.transform((tuple) => {
    const [event, payload, metadata] = tuple;
    return {
      event,
      payload,
      __livething: metadataToLiveThing(metadata),
    };
  }),
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validString(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= limit;
}

function validOptionalSequence(value: unknown): boolean {
  return (
    value === undefined || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
  );
}

function validExchange(input: unknown): boolean {
  if (!isRecord(input) || Object.keys(input).length === 0) return false;

  if (Object.keys(input).some((key) => key !== 'id' && key !== 'source')) return false;

  if (input.id !== undefined && !validString(input.id, WIRE_LIMITS.wireId)) return false;

  return input.source === undefined || input.source === 'server' || input.source === 'client';
}

function validChannel(input: unknown): boolean {
  if (!isRecord(input) || !validString(input.name, WIRE_LIMITS.channel)) return false;

  const allowed = ['name', 'family', 'unsubscribeId', 'membership', 'inbox', 'readReceipts'];
  if (Object.keys(input).some((key) => !allowed.includes(key))) return false;

  if (input.family !== undefined && !validString(input.family, WIRE_LIMITS.channelFamily)) {
    return false;
  }

  if (input.unsubscribeId !== undefined && !validString(input.unsubscribeId, WIRE_LIMITS.wireId)) {
    return false;
  }

  if (
    input.membership !== undefined &&
    input.membership !== 'persistent' &&
    input.membership !== 'ephemeral'
  ) {
    return false;
  }

  if (input.inbox !== undefined && typeof input.inbox !== 'boolean') return false;

  return input.readReceipts === undefined || typeof input.readReceipts === 'boolean';
}

function validDelivery(input: unknown): boolean {
  if (!isRecord(input) || Object.keys(input).length === 0) return false;

  if (Object.keys(input).some((key) => key !== 'id' && key !== 'seq')) return false;

  if (input.id !== undefined && !validString(input.id, WIRE_LIMITS.wireId)) return false;

  return validOptionalSequence(input.seq);
}

function validStream(input: unknown): boolean {
  if (!isRecord(input) || !validString(input.id, WIRE_LIMITS.streamId)) return false;

  const allowed = ['id', 'event', 'durability', 'seq', 'nudgeId', 'terminated'];
  if (Object.keys(input).some((key) => !allowed.includes(key))) return false;

  if (input.event !== undefined && !validString(input.event, WIRE_LIMITS.event)) return false;

  if (
    input.durability !== undefined &&
    input.durability !== 'ephemeral' &&
    input.durability !== 'persistent'
  ) {
    return false;
  }

  if (!validOptionalSequence(input.seq)) return false;

  if (input.nudgeId !== undefined && !validString(input.nudgeId, WIRE_LIMITS.wireId)) return false;

  return input.terminated === undefined || typeof input.terminated === 'boolean';
}

function validUpload(input: unknown): boolean {
  if (!isRecord(input) || !validString(input.id, WIRE_LIMITS.wireId)) return false;

  if (Object.keys(input).some((key) => key !== 'id' && key !== 'seq' && key !== 'size')) {
    return false;
  }

  if (input.seq !== undefined && input.size !== undefined) return false;

  return validOptionalSequence(input.seq) && validOptionalSequence(input.size);
}

function fastMetadata(input: unknown): LiveThingProtocol | null | undefined {
  if (input === null) return { channelFamily: null };

  if (!isRecord(input) || Object.keys(input).length === 0) return undefined;

  const allowed = ['exchange', 'channel', 'delivery', 'stream', 'upload'];
  if (Object.keys(input).some((key) => !allowed.includes(key))) return undefined;

  if (input.upload !== undefined && !validUpload(input.upload)) return undefined;

  if (input.exchange !== undefined && !validExchange(input.exchange)) return undefined;

  if (input.channel !== undefined && !validChannel(input.channel)) return undefined;

  if (input.delivery !== undefined && !validDelivery(input.delivery)) return undefined;

  if (input.stream !== undefined && !validStream(input.stream)) return undefined;

  return metadataToLiveThing(input);
}

/**
 * The first check on every received frame, text or a binary frame's envelope: a three-item
 * array whose first item is a string. A frame of any other shape is dropped.
 */
export function isWireTuple(parsed: unknown): parsed is [string, unknown, unknown] {
  return Array.isArray(parsed) && parsed.length === 3 && typeof parsed[0] === 'string';
}

/** Fast user-frame parser used by the gateway before Valibot's detailed error path. */
export function parseUserEventFrame(input: unknown): ProtocolFrame {
  if (Array.isArray(input) && input.length === 3 && validString(input[0], WIRE_LIMITS.event)) {
    const livething = fastMetadata(input[2]);
    if (livething !== undefined) {
      return {
        event: input[0],
        payload: input[1],
        __livething: livething ?? { channelFamily: null },
      };
    }
  }

  return v.parse(UserEventFrameSchema, input) as ProtocolFrame;
}

export type IncomingProtocolFrame = v.InferOutput<typeof IncomingProtocolFrame>;
export type OutgoingProtocolFrame = v.InferOutput<typeof OutgoingProtocolFrame>;
export type UserEventFrame = v.InferOutput<typeof UserEventFrameSchema>;
export type LiveThingRouting = Partial<LiveThingProtocol>;
export type SubscribeFrame = v.InferOutput<typeof SubscribeFrame>;
export type UnsubscribeFrame = v.InferOutput<typeof UnsubscribeFrame>;
export type ReplayFrame = v.InferOutput<typeof ReplayFrame>;
export type StreamCancelFrame = v.InferOutput<typeof StreamCancelFrame>;
export type ContinueStreamFrame = v.InferOutput<typeof ContinueStreamFrame>;
export type UploadEndFrame = v.InferOutput<typeof UploadEndFrame>;
export type UploadCancelFrame = v.InferOutput<typeof UploadCancelFrame>;
type ReceivedFrame = v.InferOutput<typeof ReceivedFrame>;
export type ReadFrame = v.InferOutput<typeof ReadFrame>;
type ReceivedQueryFrame = v.InferOutput<typeof ReceivedQueryFrame>;
type ReadQueryFrame = v.InferOutput<typeof ReadQueryFrame>;
export type SubscribeOkFrame = v.InferOutput<typeof SubscribeOkFrame>;
type UnsubscribeOkFrame = v.InferOutput<typeof UnsubscribeOkFrame>;
type StreamOkFrame = v.InferOutput<typeof StreamOkFrame>;
type NudgeOkFrame = v.InferOutput<typeof NudgeOkFrame>;
type StreamEndFrame = v.InferOutput<typeof StreamEndFrame>;
type ErrorFrame = v.InferOutput<typeof ErrorFrame>;
type KickedFrame = v.InferOutput<typeof KickedFrame>;
type MemberJoinFrame = v.InferOutput<typeof MemberJoinFrame>;
type MemberLeaveFrame = v.InferOutput<typeof MemberLeaveFrame>;
type MemberOnlineFrame = v.InferOutput<typeof MemberOnlineFrame>;
type MemberOfflineFrame = v.InferOutput<typeof MemberOfflineFrame>;
type MemberSyncFrame = v.InferOutput<typeof MemberSyncFrame>;
type ReceivedFanoutFrame = v.InferOutput<typeof ReceivedFanoutFrame>;
type ReadFanoutFrame = v.InferOutput<typeof ReadFanoutFrame>;
type ReceivedQueryResultFrame = v.InferOutput<typeof ReceivedQueryResultFrame>;
type ReadQueryResultFrame = v.InferOutput<typeof ReadQueryResultFrame>;
type GapFrame = v.InferOutput<typeof GapFrame>;

const INCOMING_NAMES = [
  '__subscribe__',
  '__unsubscribe__',
  '__replay__',
  '__streamCancel__',
  '__continueStream__',
  '__received__',
  '__read__',
  '__receivedQuery__',
  '__readQuery__',
  '__uploadEnd__',
  '__uploadCancel__',
] as const;
const OUTGOING_NAMES = [
  '__uploadAck__',
  '__uploadDone__',
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
  '__received__',
  '__read__',
  '__receivedQuery__',
  '__readQuery__',
  '__gap__',
  '__resume__',
] as const;
export type IncomingProtocolEvent = (typeof INCOMING_NAMES)[number];
export const OUTGOING_PROTOCOL_EVENT_NAMES: ReadonlySet<string> = new Set(OUTGOING_NAMES);

export function isProtocolEventName(name: unknown): name is `__${string}__` {
  return (
    typeof name === 'string' && name.length > 4 && name.startsWith('__') && name.endsWith('__')
  );
}
