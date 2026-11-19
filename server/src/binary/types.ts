import type { BinaryInput } from '@livething/core';
import type { AppCtx, ConnectionlessCtx } from '~/_define/app-ctx.ts';
import type { AnyCapability, BrandsOf, Contribution } from '~/_define/capability.ts';
import type { InferInput } from '~/_define/contract.ts';
import type {
  ChannelCtx,
  ChannelHandlerContribution,
  ChannelOwnSlice,
  DurableStreamOptions,
  NudgesContract,
  NudgesHandle,
  RateLimitField,
  RecordedBufferOptions,
  StreamCtx,
  StreamHandleBase,
  StreamHandlerValue,
  StreamNudgeMap,
} from '~/_define/server.ts';
import type { IncomingPrimitive } from '~/incoming/incoming.ts';
import type { Primitive } from '~/primitive.ts';
import type { RequestPrimitive } from '~/request/request.ts';
import type { Jsonify, Payload, Validator } from '~/types.ts';
import type { UploadDiscardHandle, UploadPiece, UploadRunHandle } from '~/upload/upload.ts';

/** Configuration object for a `binary.on(...)` handler, at the top level or in a channel. */
type BinaryOnConfig<TCtx, TInput, TCaps extends readonly AnyCapability[]> = {
  /** Optional schema for the info. Omit it to accept any info (typed `unknown`). */
  readonly input?: TInput;
  /**
   * The most bytes the frame may carry. Optional: without it, the limit is the largest
   * that fits in the adapter's message limit. A value that cannot fit fails at startup.
   */
  readonly maxBytes?: number;
  /** Run this handler alongside earlier work on the same connection. Defaults to ordered execution. */
  readonly allowInterleaving?: boolean;
  /**
   * Runs each time the client sends this binary event, with the checked info and a plain
   * `Uint8Array` view of the bytes. The view shares the frame's memory: `bytes.slice()`
   * copies it, for code that keeps the bytes after `run` returns.
   */
  run(ctx: TCtx, input: InferInput<TInput>, bytes: Uint8Array): void | Promise<void>;
} & RateLimitField<TCaps>;

/** What a `binary.request(...)` handler's `run` returns: the reply's info, then its bytes. */
interface BinaryReply<TInfo> {
  /** The reply's info: a plain object, or `null` when there is nothing to say. */
  readonly info: TInfo;
  /** The reply's bytes. Leave them out to reply with none. */
  readonly bytes?: BinaryInput;
}

/** One chunk a `binary.stream(...)` generator yields: its info, then its bytes. */
interface BinaryChunk<TInfo> {
  /** The chunk's info: a plain object, or `null` when there is nothing to say. */
  readonly info: TInfo;
  /** The chunk's bytes. */
  readonly bytes: BinaryInput;
}

/**
 * A reply with no keys but `info` and `bytes`. A typo such as `byte` must not compile into a
 * reply with no bytes, and an inferred return type gets no excess-property check.
 */
type ExactReply<TReply> = BinaryReply<Payload> & {
  readonly [K in Exclude<keyof TReply, 'info' | 'bytes'>]: never;
};

/** Configuration object for a `binary.request(...)` handler, at the top level or in a channel. */
type BinaryRequestConfig<TCtx, TInput, TReply, TCaps extends readonly AnyCapability[]> = {
  /** Optional schema for the request's info. Omit it to accept any info (typed `unknown`). */
  readonly input?: TInput;
  /** The most bytes the request frame may carry. As on `binary.on(...)`. */
  readonly maxBytes?: number;
  /** Run this request alongside earlier work on the same connection. Defaults to interleaved execution. */
  readonly allowInterleaving?: boolean;
  /**
   * Runs the request, with the checked info and the request's bytes, and returns the reply:
   * `{ info, bytes }`, sent as one binary frame. The reply type comes from what it returns.
   */
  run(ctx: TCtx, input: InferInput<TInput>, bytes: Uint8Array): TReply | Promise<TReply>;
} & RateLimitField<TCaps>;

/** The info type of a binary request's reply. */
type ReplyInfo<TReply> = TReply extends { readonly info: infer TInfo } ? TInfo : never;

/** Configuration object for a `binary.stream(...)` handler, at the top level or in a channel. */
type BinaryStreamConfig<TCtx, TInput, TChunk, TNudges> = {
  /** Optional schema for the info of the frame that starts the stream. */
  readonly input?: TInput;
  /** The most bytes the frame that starts the stream may carry. As on `binary.on(...)`. */
  readonly maxBytes?: number;
  /** Client→server steering signals delivered into the running generator. They are text frames. */
  readonly nudges?: TNudges;
  /** Fan the stream out to every connection (or channel member) instead of one. */
  readonly broadcast?: boolean;
  /** Permit overlapping streams of the same event on one connection (default false). */
  readonly allowConcurrent?: boolean;
  /** The async generator: each `{ info, bytes }` it yields is sent as one binary frame. */
  run(
    ctx: TCtx,
    input: InferInput<TInput>,
    bytes: Uint8Array,
  ): AsyncGenerator<BinaryChunk<TChunk>, void, unknown>;
};

/** Configuration object for a `binary.recordedStream(...)` handler, at the top level or in a channel. */
type BinaryRecordedStreamConfig<TCtx, TInput, TChunk, TNudges> = BinaryStreamConfig<
  TCtx,
  TInput,
  TChunk,
  TNudges
> &
  DurableStreamOptions &
  RecordedBufferOptions;

/** The contract entry of one binary stream. */
type BinaryStreamEntry<TInput, TChunk, TNudges> = {
  payload: InferInput<TInput>;
  chunk: Jsonify<TChunk>;
  nudges: NudgesContract<TNudges>;
};

/** A channel's `binary.request(...)`, granted by `binary()` with `clientRequests()`. */
interface ChannelBinaryRequestMethods<
  TCtx,
  TKey extends string,
  TOwn,
  TCaps extends readonly AnyCapability[],
> {
  /** Create a binary request handler value scoped to this channel. Pass it to `assemble()` to activate it. */
  request<
    TEvent extends string,
    TInput extends Validator | undefined = undefined,
    TReply extends ExactReply<TReply> = BinaryReply<null>,
  >(
    event: TEvent,
    config: BinaryRequestConfig<TCtx, TInput, TReply, TCaps>,
  ): ChannelHandlerContribution<
    TKey,
    TOwn,
    {
      binaryClientRequests: Record<
        TEvent,
        { payload: InferInput<TInput>; response: ReplyInfo<TReply> }
      >;
    }
  >;
}

/** A channel's `binary.stream(...)`, granted by `binary()` with `stream()`. */
interface ChannelBinaryStreamMethods<
  TCtx,
  TKey extends string,
  TOwn,
  TCaps extends readonly AnyCapability[],
> {
  /** Create a binary stream handler value scoped to this channel. Pass it to `assemble()` to activate it. */
  stream<
    TEvent extends string,
    TChunk extends Payload = Record<string, unknown>,
    TInput extends Validator | undefined = undefined,
    const TNudges extends StreamNudgeMap = {},
  >(
    event: TEvent,
    config: BinaryStreamConfig<
      TCtx & { stream: StreamHandleBase & NudgesHandle<TNudges> },
      TInput,
      TChunk,
      TNudges
    > &
      RateLimitField<TCaps>,
  ): ChannelHandlerContribution<
    TKey,
    TOwn,
    { binaryStreams: Record<TEvent, BinaryStreamEntry<TInput, TChunk, TNudges>> }
  >;
}

/** A channel's `binary.recordedStream(...)`, granted by `binary()` with `recordedStream()`. */
interface ChannelBinaryRecordedStreamMethods<
  TCtx,
  TKey extends string,
  TOwn,
  TCaps extends readonly AnyCapability[],
> {
  /** Create a recorded binary stream handler value scoped to this channel. Pass it to `assemble()` to activate it. */
  recordedStream<
    TEvent extends string,
    TChunk extends Payload = Record<string, unknown>,
    TInput extends Validator | undefined = undefined,
    const TNudges extends StreamNudgeMap = {},
  >(
    event: TEvent,
    config: BinaryRecordedStreamConfig<
      TCtx & { stream: StreamHandleBase & NudgesHandle<TNudges> },
      TInput,
      TChunk,
      TNudges
    > &
      RateLimitField<TCaps>,
  ): ChannelHandlerContribution<
    TKey,
    TOwn,
    { binaryRecordedStreams: Record<TEvent, BinaryStreamEntry<TInput, TChunk, TNudges>> }
  >;
}

/**
 * A channel's `binary.on(...)`, granted by the `binary()` capability, with `binary.request`,
 * `binary.stream` and `binary.recordedStream` when `clientRequests()`, `stream()` and
 * `recordedStream()` are listed too.
 */
export interface ChannelBinaryMethods<
  TSlots,
  TMeta,
  TKey extends string,
  TParams,
  TOutgoing extends Record<string, unknown>,
  TAddressing extends string,
  TSubscribe,
  TCaps extends readonly AnyCapability[] = readonly [],
  TServerRequests = {},
  TChannelBrand extends string = never,
  TChannelExtras = {},
> {
  readonly binary: {
    /** Create a binary event handler value scoped to this channel. Pass it to `assemble()` to activate it. */
    on<TEvent extends string, TInput extends Validator | undefined = undefined>(
      event: TEvent,
      config: BinaryOnConfig<
        ChannelCtx<
          TSlots,
          TMeta,
          TParams,
          TOutgoing,
          TCaps,
          TServerRequests,
          TChannelBrand,
          TChannelExtras
        >,
        TInput,
        TCaps
      >,
    ): ChannelHandlerContribution<
      TKey,
      ChannelOwnSlice<
        TParams,
        TOutgoing,
        TAddressing,
        TSubscribe,
        TServerRequests,
        TChannelBrand,
        TChannelExtras
      >,
      { binaryIncoming: Record<TEvent, InferInput<TInput>> }
    >;
  } & ('clientRequests' extends BrandsOf<TCaps>
    ? ChannelBinaryRequestMethods<
        ChannelCtx<
          TSlots,
          TMeta,
          TParams,
          TOutgoing,
          TCaps,
          TServerRequests,
          TChannelBrand,
          TChannelExtras
        >,
        TKey,
        ChannelOwnSlice<
          TParams,
          TOutgoing,
          TAddressing,
          TSubscribe,
          TServerRequests,
          TChannelBrand,
          TChannelExtras
        >,
        TCaps
      >
    : {}) &
    ('stream' extends BrandsOf<TCaps>
      ? ChannelBinaryStreamMethods<
          ChannelCtx<
            TSlots,
            TMeta,
            TParams,
            TOutgoing,
            TCaps,
            TServerRequests,
            TChannelBrand,
            TChannelExtras
          >,
          TKey,
          ChannelOwnSlice<
            TParams,
            TOutgoing,
            TAddressing,
            TSubscribe,
            TServerRequests,
            TChannelBrand,
            TChannelExtras
          >,
          TCaps
        >
      : {}) &
    ('recordedStream' extends BrandsOf<TCaps>
      ? ChannelBinaryRecordedStreamMethods<
          ChannelCtx<
            TSlots,
            TMeta,
            TParams,
            TOutgoing,
            TCaps,
            TServerRequests,
            TChannelBrand,
            TChannelExtras
          >,
          TKey,
          ChannelOwnSlice<
            TParams,
            TOutgoing,
            TAddressing,
            TSubscribe,
            TServerRequests,
            TChannelBrand,
            TChannelExtras
          >,
          TCaps
        >
      : {});
}

/** The value `base.binary.on(...)` returns — a handler primitive that declares its binary slot. */
export type BinaryIncomingHandlerValue<TEvent extends string, TPayload> = IncomingPrimitive<
  TEvent,
  TPayload
> &
  Contribution<{ binaryIncoming: Record<TEvent, TPayload> }>;

/**
 * Builder methods granted by the `binary()` capability, under `base.binary`. A binary
 * handler takes the same options as its JSON version, plus `maxBytes`.
 */
export interface BinaryMethods<TSlots, TMeta, TCaps extends readonly AnyCapability[], TBrand> {
  readonly binary: {
    /**
     * Create a handler value for one client→server binary event: JSON info, which
     * `input` checks, and raw bytes, which `maxBytes` limits. Pass the returned value to
     * `assemble()` to activate it.
     */
    on<TEvent extends string, TSchema extends Validator | undefined = undefined>(
      event: TEvent,
      config: BinaryOnConfig<AppCtx<TSlots, TMeta, TCaps>, TSchema, TCaps>,
    ): BinaryIncomingHandlerValue<TEvent, InferInput<TSchema>>;
  } & ('clientRequests' extends TBrand ? BinaryRequestMethods<TSlots, TMeta, TCaps> : {}) &
    ('stream' extends TBrand ? BinaryStreamMethods<TSlots, TMeta, TCaps> : {}) &
    ('recordedStream' extends TBrand ? BinaryRecordedStreamMethods<TSlots, TMeta, TCaps> : {}) &
    ('uploads' extends TBrand ? BinaryUploadMethods<TSlots, TMeta, TCaps> : {});
}

/** What an upload's `run` returns: the reply's info, and no other key. */
type ExactUploadReply<TReply> = { readonly info: Payload } & {
  readonly [K in Exclude<keyof TReply, 'info'>]: never;
};

/** Configuration object for a `base.binary.upload(...)` handler. */
type BinaryUploadConfig<
  TSlots,
  TMeta,
  TInput,
  TState extends Validator | undefined,
  TReply,
  TCaps extends readonly AnyCapability[],
> = {
  /** Optional schema for the upload's input, sent once at the start. */
  readonly input?: TInput;
  /**
   * Optional schema for the state that `ctx.upload.saved()` keeps. LiveThing checks a stored
   * state with it when it reads the state back: on a resume, and before `onDiscard`. Without
   * it, `saved()` keeps no state. It must be synchronous: an async schema throws a
   * `LiveThingConfigError` when LiveThing first reads a state with it.
   */
  readonly state?: TState;
  /** The most bytes the whole upload may have. Default: 100 MiB. */
  readonly maxBytes?: number;
  /** The biggest piece the client sends, in bytes. Default: 256 KiB. */
  readonly pieceBytes?: number;
  /** The most bytes the client may send past what `run` has read. Default: 2 MiB. */
  readonly windowBytes?: number;
  /**
   * Reads the pieces with `for await` and stores them. Call `ctx.upload.saved(offset)` after
   * bytes are really stored, so a resume starts there. Returns `{ info }`, the reply that the
   * client's `start()` resolves with. On a resume, `run` runs again from
   * `ctx.upload.savedThrough`.
   */
  run(
    ctx: AppCtx<TSlots, TMeta, TCaps> & { readonly upload: UploadRunHandle<TState> },
    input: InferInput<TInput>,
    pieces: AsyncIterable<UploadPiece>,
  ): TReply | Promise<TReply>;
  /**
   * Runs when an upload ends without finishing: on cancel, on expiry, and when `run` throws.
   * Abort a multipart upload here. It runs at least once, so it must be safe to run twice.
   */
  onDiscard?(
    ctx: ConnectionlessCtx<TSlots, TMeta, TCaps> & { readonly upload: UploadDiscardHandle<TState> },
    input: InferInput<TInput>,
  ): void | Promise<void>;
} & RateLimitField<TCaps>;

/** The value `base.binary.upload(...)` returns — a handler primitive that declares its slot. */
export type BinaryUploadHandlerValue<
  TEvent extends string,
  TPayload,
  TInfo,
> = Primitive<'upload'> & {
  readonly event: TEvent;
} & Contribution<{ binaryUploads: Record<TEvent, { payload: TPayload; response: TInfo }> }>;

/** `base.binary.upload(...)`, granted by `binary()` with `uploads()`. */
interface BinaryUploadMethods<TSlots, TMeta, TCaps extends readonly AnyCapability[]> {
  /**
   * Create a handler value for one client→server upload: one large file, sent in pieces with
   * speed control, cancel and resume. The start frame's input is checked once; `run` reads
   * the pieces and returns `{ info }`. Uploads are top-level only.
   */
  upload<
    TEvent extends string,
    TSchema extends Validator | undefined = undefined,
    TState extends Validator | undefined = undefined,
    TReply extends ExactUploadReply<TReply> = { readonly info: null },
  >(
    event: TEvent,
    config: BinaryUploadConfig<TSlots, TMeta, TSchema, TState, TReply, TCaps>,
  ): BinaryUploadHandlerValue<TEvent, InferInput<TSchema>, ReplyInfo<TReply>>;
}

/** The value `base.binary.request(...)` returns — a handler primitive that declares its slot. */
export type BinaryRequestHandlerValue<TEvent extends string, TPayload, TInfo> = RequestPrimitive<
  TEvent,
  TPayload,
  TInfo
> &
  Contribution<{ binaryClientRequests: Record<TEvent, { payload: TPayload; response: TInfo }> }>;

/** `base.binary.request(...)`, granted by `binary()` with `clientRequests()`. */
interface BinaryRequestMethods<TSlots, TMeta, TCaps extends readonly AnyCapability[]> {
  /**
   * Create a handler value for one client→server binary request. Like `base.request`, but
   * the request and the reply are binary frames: `run` gets the checked info and the bytes,
   * and returns `{ info, bytes }`. The reply type comes from what it returns. A registered
   * error that `run` throws goes back as the normal text `__error__`.
   */
  request<
    TEvent extends string,
    TSchema extends Validator | undefined = undefined,
    TReply extends ExactReply<TReply> = BinaryReply<null>,
  >(
    event: TEvent,
    config: BinaryRequestConfig<AppCtx<TSlots, TMeta, TCaps>, TSchema, TReply, TCaps>,
  ): BinaryRequestHandlerValue<TEvent, InferInput<TSchema>, ReplyInfo<TReply>>;
}

/** `base.binary.stream(...)`, granted by `binary()` with `stream()`. */
interface BinaryStreamMethods<TSlots, TMeta, TCaps extends readonly AnyCapability[]> {
  /**
   * Create a server-pushed binary stream handler value. Like `base.stream`, but each chunk is
   * one binary frame: the generator yields `{ info, bytes }`. `__streamOk__`, `__streamEnd__`,
   * errors, cancels and nudges stay text frames.
   */
  stream<
    TEvent extends string,
    TChunk extends Payload = Record<string, unknown>,
    TInput extends Validator | undefined = undefined,
    const TNudges extends StreamNudgeMap = {},
  >(
    event: TEvent,
    config: BinaryStreamConfig<StreamCtx<TSlots, TMeta, TNudges, TCaps>, TInput, TChunk, TNudges>,
  ): StreamHandlerValue<TEvent, BinaryStreamEntry<TInput, TChunk, TNudges>, 'binaryStreams'>;
}

/** `base.binary.recordedStream(...)`, granted by `binary()` with `recordedStream()`. */
interface BinaryRecordedStreamMethods<TSlots, TMeta, TCaps extends readonly AnyCapability[]> {
  /**
   * Create a recorded server-pushed binary stream handler value. Like `base.recordedStream`,
   * but each chunk is one binary frame: the generator yields `{ info, bytes }`, and each chunk
   * is stored with its bytes, so a client that loses its connection continues the stream.
   */
  recordedStream<
    TEvent extends string,
    TChunk extends Payload = Record<string, unknown>,
    TInput extends Validator | undefined = undefined,
    const TNudges extends StreamNudgeMap = {},
  >(
    event: TEvent,
    config: BinaryRecordedStreamConfig<
      StreamCtx<TSlots, TMeta, TNudges, TCaps>,
      TInput,
      TChunk,
      TNudges
    >,
  ): StreamHandlerValue<
    TEvent,
    BinaryStreamEntry<TInput, TChunk, TNudges>,
    'binaryRecordedStreams'
  >;
}
