/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { Primitive } from '~/primitive.ts';
import type { Validator } from '~/types.ts';

/**
 * Declares one client→server event that can be sent to a running stream as a
 * mid-stream signal. Created by `nudge()` and collected by `StreamBuilder`.
 *
 * A good beginner mental model is "a nudge is a control message for a stream
 * that is already running".
 */
export interface NudgeDeclaration<TEvent extends string = string, TPayload = unknown> {
  /** The event name the client sends to nudge the stream. */
  readonly event: TEvent;
  /** Optional schema validator for the nudge payload. */
  readonly validator?: Validator<TPayload>;
}

/**
 * Declare a nudge event for a stream. A nudge is a message the client can send
 * while the stream is active to influence its output (e.g. "pause", "filter by
 * category").
 *
 * The generator receives nudges as the value of each `yield` expression via
 * the `TNext` type parameter.
 *
 * @param event     The event name the client sends to nudge.
 * @param validator Optional schema validator for the nudge payload.
 *
 * @example
 * ```ts
 * import * as v from 'valibot';
 *
 * const pause = nudge('pause');
 * const speedUp = nudge('speed-up', v.object({ factor: v.number() }));
 * ```
 */
export function nudge<TEvent extends string>(event: TEvent): NudgeDeclaration<TEvent, unknown>;
/**
 * Declare a nudge event for a stream. A nudge is a message the client can send
 * while the stream is active to influence its output (e.g. "pause", "filter by
 * category").
 *
 * The generator receives nudges as the value of each `yield` expression via
 * the `TNext` type parameter.
 *
 * @param event     The event name the client sends to nudge.
 * @param validator Optional schema validator for the nudge payload.
 *
 * @example
 * ```ts
 * import * as v from 'valibot';
 *
 * const pause = nudge('pause');
 * const speedUp = nudge('speed-up', v.object({ factor: v.number() }));
 * ```
 */
export function nudge<TEvent extends string, TPayload>(
  event: TEvent,
  validator: (value: unknown) => TPayload,
): NudgeDeclaration<TEvent, TPayload>;
/**
 * Declare a nudge event for a stream. A nudge is a message the client can send
 * while the stream is active to influence its output (e.g. "pause", "filter by
 * category").
 *
 * The generator receives nudges as the value of each `yield` expression via
 * the `TNext` type parameter.
 *
 * @param event     The event name the client sends to nudge.
 * @param validator Optional schema validator for the nudge payload.
 *
 * @example
 * ```ts
 * import * as v from 'valibot';
 *
 * const pause = nudge('pause');
 * const speedUp = nudge('speed-up', v.object({ factor: v.number() }));
 * ```
 */
export function nudge<TEvent extends string, TSchema extends StandardSchemaV1>(
  event: TEvent,
  validator: TSchema,
): NudgeDeclaration<TEvent, StandardSchemaV1.InferOutput<TSchema>>;
/**
 * Declare a nudge event for a stream. A nudge is a message the client can send
 * while the stream is active to influence its output (e.g. "pause", "filter by
 * category").
 *
 * The generator receives nudges as the value of each `yield` expression via
 * the `TNext` type parameter.
 *
 * @param event     The event name the client sends to nudge.
 * @param validator Optional schema validator for the nudge payload.
 *
 * @example
 * ```ts
 * s.nudge(nudge('pause'))
 * s.nudge(nudge('speed-up', v.object({ factor: v.number() })))
 * ```
 */
export function nudge(event: string, validator?: Validator): NudgeDeclaration {
  return { event, validator };
}

/**
 * The shape of a single nudge message, as received by the generator's `yield`
 * return value.
 */
export interface NudgeMessage<TEvent extends string = string, TPayload = unknown> {
  /** The event name of this nudge. */
  readonly event: TEvent;
  /** The validated nudge payload. */
  readonly payload: TPayload;
}

/**
 * A tuple of all nudge messages that arrived since the last `yield`, typed
 * from the `TNudges` declaration tuple.
 */
export type StreamNudgeMessages<TNudges extends readonly NudgeDeclaration[]> = readonly {
  [TIndex in keyof TNudges]: TNudges[TIndex] extends NudgeDeclaration<infer TEvent, infer TPayload>
    ? NudgeMessage<TEvent, TPayload>
    : never;
}[number][];

/**
 * The nudge API injected into the stream generator's context. Call
 * `ctx.nudges(rawValue)` to deserialise and type the nudge messages that
 * arrived since the last yield.
 */
export interface StreamNudgesApi<TNudges extends readonly NudgeDeclaration[]> {
  /**
   * Parse the raw value returned from a stream `yield` into typed nudge messages.
   *
   * Call this inside `.generate(...)` after a `yield` when the stream declared
   * one or more `.nudge(...)` controls.
   */
  nudges(value: unknown): StreamNudgeMessages<TNudges>;
}

/**
 * The `ctx` type inside a stream generator: the base handler context extended
 * with the `nudges()` helper only when at least one nudge is declared.
 */
export type StreamHandlerContext<TBaseCtx, TNudges extends readonly NudgeDeclaration[]> = TBaseCtx &
  (TNudges extends readonly [] ? {} : StreamNudgesApi<TNudges>);

/**
 * The function signature for an `AsyncGenerator` used as a stream handler.
 *
 * Uses the `bivarianceHack` pattern to allow TypeScript to check the generator
 * function in both covariant and contravariant positions.
 */
export type GeneratorFn<TCtx = any, TPayload = unknown, TChunks = unknown, TNext = any> = {
  bivarianceHack(ctx: TCtx, payload: TPayload): AsyncGenerator<TChunks, void, TNext>;
}['bivarianceHack'];

/**
 * Describes the trigger event that starts a stream: name, optional validator,
 * and whether chunks should be broadcast to all connections.
 */
export interface StreamStartDeclaration<TEvent extends string = string, TPayload = unknown> {
  /** The event name the client sends to start the stream. */
  readonly event: TEvent;
  /** Optional schema validator for the trigger payload. */
  readonly validator?: Validator<TPayload>;
  /** When `true`, stream chunks are sent to all connections, not just the trigger connection. */
  readonly broadcast?: boolean;
  /**
   * When `true`, the same client can run more than one stream of this event
   * at the same time. Default is `false`: a second start of the same event
   * on a connection that already has one running is rejected with
   * `stream-already-active`.
   */
  readonly allowConcurrent?: boolean;
}

/**
 * The primitive type produced by `stream()`. Describes the trigger event, the
 * chunk type declared by `.chunk(...)`, the nudges, and the broadcast flag.
 * The engine uses this to set up stream routing and dispatch.
 *
 * `_TChunks` is used only by the type system (for the `generate()` pairing) and
 * is not stored at runtime.
 */
export interface StreamPrimitive<
  TEvent extends string = string,
  TPayload = unknown,
  _TChunks = unknown,
  TNudges extends readonly NudgeDeclaration[] = readonly NudgeDeclaration[],
> extends Primitive<'stream'> {
  /** The event name that triggers this stream. */
  readonly event: TEvent;
  /** Optional schema validator for the trigger payload. */
  readonly validator?: Validator<TPayload>;
  /** The nudge declarations registered with this stream. */
  readonly nudges: TNudges;
  /** Whether stream chunks are broadcast to all connections. */
  readonly broadcast: boolean;
  /**
   * Whether the same connection can run more than one stream of this event at
   * the same time. Default `false` — a second start while one is running is
   * rejected with `stream-already-active`.
   */
  readonly allowConcurrent: boolean;
}

/** Extracts the payload type from a `StreamPrimitive`. */
type StreamPayload<TStream extends StreamPrimitive> =
  TStream extends StreamPrimitive<string, infer TPayload, any, any> ? TPayload : never;

/** Extracts the chunk type from a `StreamPrimitive`. */
type StreamChunks<TStream extends StreamPrimitive> =
  TStream extends StreamPrimitive<string, any, infer TChunks, any> ? TChunks : never;

/** Extracts the nudges tuple from a `StreamPrimitive`. */
type StreamNudges<TStream extends StreamPrimitive> =
  TStream extends StreamPrimitive<string, any, any, infer TNudges> ? TNudges : never;

/**
 * The primitive type produced by `generate()`. Pairs a `StreamPrimitive` with
 * the generator function that produces chunks. The engine runs the generator
 * when the trigger event is received.
 */
export interface GeneratePrimitive<
  TStream extends StreamPrimitive = StreamPrimitive,
  TBaseCtx = any,
  TNext = any,
> extends Primitive<'generate'> {
  /** The stream declaration this generator is paired with. */
  readonly stream: TStream;
  /** Convenience reference to the trigger event name (mirrors `stream.event`). */
  readonly event: TStream['event'];
  /** The `AsyncGenerator` function that produces chunks. */
  readonly generator: GeneratorFn<
    StreamHandlerContext<TBaseCtx, StreamNudges<TStream>>,
    StreamPayload<TStream>,
    StreamChunks<TStream>,
    TNext
  >;
}

const STREAM_KEY = Symbol('stream');
const GENERATE_KEY = Symbol('generate');

/**
 * Creates a stream declaration primitive. Describes which event triggers the
 * stream, which nudges it accepts, and whether chunks are broadcast.
 *
 * This primitive must be paired with a `generate()` primitive before the engine
 * can run the stream. In practice you rarely call `stream()` directly — the
 * `StreamBuilder` (from `.stream()` on the server builder) calls `stream()`
 * after you declare `.chunk(...)`, then pairs it with `generate()`.
 *
 * @param startDecl Trigger event name, optional validator, and broadcast flag.
 * @param nudges    Zero or more nudge declarations from `nudge()`.
 */
export function stream<
  TEvent extends string,
  TPayload,
  TChunks,
  const TNudges extends readonly NudgeDeclaration[],
>(
  startDecl: StreamStartDeclaration<TEvent, TPayload>,
  ...nudges: TNudges
): StreamPrimitive<TEvent, TPayload, TChunks, TNudges> {
  return {
    __wskit: 'stream',
    __kind: 'handler',
    __identity: [STREAM_KEY, startDecl.event],
    __requires: {},
    event: startDecl.event,
    validator: startDecl.validator,
    nudges,
    broadcast: startDecl.broadcast ?? false,
    allowConcurrent: startDecl.allowConcurrent ?? false,
  };
}

/**
 * Creates a generate primitive. Pairs a `StreamPrimitive` with the
 * `AsyncGenerator` function that produces chunks.
 *
 * In practice you rarely call `generate()` directly. The `StreamBuilder`
 * calls it via `.chunk(...).generate(handler)`.
 *
 * @param streamDecl The stream declaration to attach the generator to.
 * @param generator  The `AsyncGenerator` that yields chunks to the client.
 */
export function generate<TBaseCtx, TStream extends StreamPrimitive, TNext = any>(
  streamDecl: TStream,
  generator: GeneratorFn<
    StreamHandlerContext<TBaseCtx, StreamNudges<TStream>>,
    StreamPayload<TStream>,
    StreamChunks<TStream>,
    TNext
  >,
): GeneratePrimitive<TStream, TBaseCtx, TNext> {
  return {
    __wskit: 'generate',
    __kind: 'handler',
    __identity: [GENERATE_KEY, streamDecl.event],
    __requires: {},
    stream: streamDecl,
    event: streamDecl.event,
    generator,
  };
}

/**
 * Create a `StreamStartDeclaration` — a plain object that captures the trigger
 * event name, an optional payload validator, and the broadcast flag.
 *
 * This is a convenience factory used by `StreamBuilder` internally. You do not
 * need to call it when using the builder API — it is exposed for advanced use
 * cases where you build streams from lower-level primitives.
 */
export function start<TEvent extends string>(
  name: TEvent,
  validator?: undefined,
  options?: { broadcast?: boolean; allowConcurrent?: boolean },
): StreamStartDeclaration<TEvent, unknown>;
/**
 * Create a `StreamStartDeclaration` — a plain object that captures the trigger
 * event name, an optional payload validator, and the broadcast flag.
 *
 * This is a convenience factory used by `StreamBuilder` internally. You do not
 * need to call it when using the builder API — it is exposed for advanced use
 * cases where you build streams from lower-level primitives.
 */
export function start<TEvent extends string, TPayload>(
  name: TEvent,
  validator: (value: unknown) => TPayload,
  options?: { broadcast?: boolean; allowConcurrent?: boolean },
): StreamStartDeclaration<TEvent, TPayload>;
/**
 * Create a `StreamStartDeclaration` — a plain object that captures the trigger
 * event name, an optional payload validator, and the broadcast flag.
 *
 * This is a convenience factory used by `StreamBuilder` internally. You do not
 * need to call it when using the builder API — it is exposed for advanced use
 * cases where you build streams from lower-level primitives.
 */
export function start<TEvent extends string, TSchema extends StandardSchemaV1>(
  name: TEvent,
  validator: TSchema,
  options?: { broadcast?: boolean; allowConcurrent?: boolean },
): StreamStartDeclaration<TEvent, StandardSchemaV1.InferOutput<TSchema>>;
/**
 * Create a `StreamStartDeclaration` — a plain object that captures the trigger
 * event name, an optional payload validator, and the broadcast flag.
 *
 * This is a convenience factory used by `StreamBuilder` internally. You do not
 * need to call it when using the builder API — it is exposed for advanced use
 * cases where you build streams from lower-level primitives.
 */
export function start(
  name: string,
  validator?: Validator,
  options?: { broadcast?: boolean; allowConcurrent?: boolean },
): StreamStartDeclaration {
  return {
    event: name,
    validator,
    broadcast: options?.broadcast,
    allowConcurrent: options?.allowConcurrent,
  };
}

/** Symbol key used to reference the stream primitive in dependency declarations. */
stream.__key = STREAM_KEY;
/** Symbol key used to reference the generate primitive in dependency declarations. */
generate.__key = GENERATE_KEY;
