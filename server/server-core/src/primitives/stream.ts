/* oxlint-disable @typescript-eslint/no-explicit-any */
import { definePrimitive } from '~/primitives/define.ts';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { Primitive } from '~/primitives/define.ts';
import type { TypeMarker } from '~/t.ts';
import type { Validator } from '~/types.ts';

// ---------------------------------------------------------------------------
// Nudge — mid-stream client message declaration
// ---------------------------------------------------------------------------

/**
 * A nudge declaration. Declares a mid-stream event the client can send
 * while the stream is running.
 */
export interface NudgeDeclaration<TEvent extends string = string, TPayload = unknown> {
  readonly event: TEvent;
  readonly validator?: Validator<TPayload>;
}

/**
 * Declare a mid-stream event the client can send while a stream is running.
 * Nudge events are scoped to the stream — they don't conflict with
 * top-level `incoming` handlers.
 */
export function nudge<TEvent extends string>(event: TEvent): NudgeDeclaration<TEvent, unknown>;
export function nudge<TEvent extends string, TPayload>(
  event: TEvent,
  validator: (value: unknown) => TPayload,
): NudgeDeclaration<TEvent, TPayload>;
export function nudge<TEvent extends string, TSchema extends StandardSchemaV1>(
  event: TEvent,
  validator: TSchema,
): NudgeDeclaration<TEvent, StandardSchemaV1.InferOutput<TSchema>>;
export function nudge(event: string, validator?: Validator): NudgeDeclaration {
  return { event, validator };
}

// ---------------------------------------------------------------------------
// Shared stream types
// ---------------------------------------------------------------------------

/**
 * A nudge message passed to the generator.
 */
export interface NudgeMessage<TEvent extends string = string, TPayload = unknown> {
  readonly event: TEvent;
  readonly payload: TPayload;
}

/**
 * The messages a stream generator can receive back from the engine after
 * yielding a chunk.
 */
export type StreamNudgeMessages<TNudges extends readonly NudgeDeclaration[]> = readonly {
  [TIndex in keyof TNudges]: TNudges[TIndex] extends NudgeDeclaration<infer TEvent, infer TPayload>
    ? NudgeMessage<TEvent, TPayload>
    : never;
}[number][];

/**
 * The extra helper methods that exist only in stream handlers.
 */
export interface StreamNudgesApi<TNudges extends readonly NudgeDeclaration[]> {
  /**
   * Read the nudge messages that arrived since the last yielded chunk.
   *
   * If no nudges arrived, this gives you an empty array.
   */
  nudges(value: unknown): StreamNudgeMessages<TNudges>;
}

/**
 * The full context seen by a stream generator: the server-level base ctx
 * plus stream-local helpers derived from the stream's own nudges.
 */
export type StreamHandlerContext<TBaseCtx, TNudges extends readonly NudgeDeclaration[]> = TBaseCtx &
  StreamNudgesApi<TNudges>;

/**
 * The async generator function for a stream. Receives context and the
 * validated trigger payload. Yields chunks to the client.
 *
 * `generate()` gets payload/chunks/nudges from the stream declaration.
 * `defineServer()` gives `ctx` its final server-level type later based on
 * what is registered in the same scope.
 */
export type GeneratorFn<TCtx = any, TPayload = unknown, TChunks = unknown, TNext = any> = {
  bivarianceHack(ctx: TCtx, payload: TPayload): AsyncGenerator<TChunks, void, TNext>;
}['bivarianceHack'];

// ---------------------------------------------------------------------------
// Stream declarations
// ---------------------------------------------------------------------------

/**
 * The stream's start identity — event name, trigger validator, and
 * optional broadcast flag.
 */
export interface StreamStartDeclaration<TEvent extends string = string, TPayload = unknown> {
  readonly event: TEvent;
  readonly validator?: Validator<TPayload>;
  readonly broadcast?: boolean;
}

/**
 * The chunk declaration for a stream.
 */
export interface StreamChunksDeclaration<TChunks = unknown> {
  readonly chunks: TypeMarker<TChunks>;
}

/** Back-compat type alias while the API settles. */
export type StreamEventDeclaration<
  TEvent extends string = string,
  TPayload = unknown,
> = StreamStartDeclaration<TEvent, TPayload>;

// ---------------------------------------------------------------------------
// StreamPrimitive — full contract
// ---------------------------------------------------------------------------

/**
 * The primitive instance returned by `stream()`.
 *
 * It is the stream contract: what starts the stream, what chunk shape the
 * server yields, and which nudges the client may send while the stream is
 * running.
 */
export interface StreamPrimitive<
  TEvent extends string = string,
  TPayload = unknown,
  TChunks = unknown,
  TNudges extends readonly NudgeDeclaration[] = readonly NudgeDeclaration[],
> extends Primitive<'stream'> {
  readonly event: TEvent;
  readonly validator?: Validator<TPayload>;
  readonly chunks: TypeMarker<TChunks>;
  readonly nudges: TNudges;
  readonly broadcast: boolean;
}

type StreamPayload<TStream extends StreamPrimitive> =
  TStream extends StreamPrimitive<string, infer TPayload, any, any> ? TPayload : never;

type StreamChunks<TStream extends StreamPrimitive> =
  TStream extends StreamPrimitive<string, any, infer TChunks, any> ? TChunks : never;

type StreamNudges<TStream extends StreamPrimitive> =
  TStream extends StreamPrimitive<string, any, any, infer TNudges> ? TNudges : never;

// ---------------------------------------------------------------------------
// GeneratePrimitive — stream generator registration
// ---------------------------------------------------------------------------

/**
 * The primitive instance returned by `generate()`.
 *
 * It connects a stream contract to the async generator that actually runs
 * when the client starts that stream.
 */
export interface GeneratePrimitive<
  TStream extends StreamPrimitive = StreamPrimitive,
  TBaseCtx = any,
  TNext = any,
> extends Primitive<'generate'> {
  readonly stream: TStream;
  readonly event: TStream['event'];
  readonly chunks: TStream['chunks'];
  readonly generator: GeneratorFn<
    StreamHandlerContext<TBaseCtx, StreamNudges<TStream>>,
    StreamPayload<TStream>,
    StreamChunks<TStream>,
    TNext
  >;
}

// ---------------------------------------------------------------------------
// Runtime factories
// ---------------------------------------------------------------------------

const STREAM_KEY = Symbol('stream');
const GENERATE_KEY = Symbol('generate');

const _stream = definePrimitive<
  'stream',
  [
    startDecl: StreamStartDeclaration,
    chunksDecl: StreamChunksDeclaration,
    ...nudges: NudgeDeclaration[],
  ],
  {
    event: string;
    validator?: Validator;
    chunks: TypeMarker<unknown>;
    nudges: readonly NudgeDeclaration[];
    broadcast: boolean;
  }
>({
  tag: 'stream' as const,
  key: STREAM_KEY,
  kind: 'handler' as const,
  registrationId(startDecl: StreamStartDeclaration) {
    return startDecl.event;
  },
  create(
    startDecl: StreamStartDeclaration,
    chunksDecl: StreamChunksDeclaration,
    ...nudges: NudgeDeclaration[]
  ) {
    return {
      event: startDecl.event,
      validator: startDecl.validator,
      chunks: chunksDecl.chunks,
      nudges,
      broadcast: startDecl.broadcast ?? false,
    };
  },
});

const _generate = definePrimitive<
  'generate',
  [streamDecl: StreamPrimitive, generator: GeneratorFn],
  {
    stream: StreamPrimitive;
    event: string;
    chunks: TypeMarker<unknown>;
    generator: GeneratorFn;
  }
>({
  tag: 'generate' as const,
  key: GENERATE_KEY,
  kind: 'handler' as const,
  registrationId(streamDecl: StreamPrimitive) {
    return streamDecl.event;
  },
  create(streamDecl: StreamPrimitive, generator: GeneratorFn) {
    return {
      stream: streamDecl,
      event: streamDecl.event,
      chunks: streamDecl.chunks,
      generator,
    };
  },
});

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Declare a stream contract. This defines the trigger event, chunk shape,
 * and optional nudges. Pass the returned value to `generate(streamDecl, fn)`.
 * The `generate(...)` primitive is what you register in `defineServer(...)`.
 *
 * ```ts
 * const aiStream = stream(
 *   start('ask-ai', AskAIValidator),
 *   chunks(t<{ text: string }>()),
 *   nudge('add-context', AddContextValidator),
 *   nudge('cancel'),
 * )
 *
 * generate(aiStream, async function* (ctx, payload) {
 *   const nudges = ctx.nudges(yield { text: payload.prompt });
 * })
 * ```
 */
export function stream<
  TEvent extends string,
  TPayload,
  TChunks,
  const TNudges extends readonly NudgeDeclaration[],
>(
  startDecl: StreamStartDeclaration<TEvent, TPayload>,
  chunksDecl: StreamChunksDeclaration<TChunks>,
  ...nudges: TNudges
): StreamPrimitive<TEvent, TPayload, TChunks, TNudges>;
export function stream(
  startDecl: StreamStartDeclaration,
  chunksDecl: StreamChunksDeclaration,
  ...nudges: NudgeDeclaration[]
): StreamPrimitive {
  return _stream(startDecl, chunksDecl, ...nudges) as unknown as StreamPrimitive;
}

/**
 * Register the async generator for a stream declaration.
 */
export function generate<TBaseCtx, TStream extends StreamPrimitive, TNext = any>(
  streamDecl: TStream,
  generator: GeneratorFn<
    StreamHandlerContext<TBaseCtx, StreamNudges<TStream>>,
    StreamPayload<TStream>,
    StreamChunks<TStream>,
    TNext
  >,
): GeneratePrimitive<TStream, TBaseCtx, TNext>;
export function generate(streamDecl: StreamPrimitive, generator: GeneratorFn): GeneratePrimitive {
  return _generate(streamDecl, generator) as unknown as GeneratePrimitive;
}

/**
 * Define the stream's start identity — the event name, trigger validator,
 * and optional broadcast flag.
 */
export function start<TEvent extends string>(
  name: TEvent,
  validator?: undefined,
  options?: { broadcast?: boolean },
): StreamStartDeclaration<TEvent, unknown>;
export function start<TEvent extends string, TPayload>(
  name: TEvent,
  validator: (value: unknown) => TPayload,
  options?: { broadcast?: boolean },
): StreamStartDeclaration<TEvent, TPayload>;
export function start<TEvent extends string, TSchema extends StandardSchemaV1>(
  name: TEvent,
  validator: TSchema,
  options?: { broadcast?: boolean },
): StreamStartDeclaration<TEvent, StandardSchemaV1.InferOutput<TSchema>>;
export function start(
  name: string,
  validator?: Validator,
  options?: { broadcast?: boolean },
): StreamStartDeclaration {
  return { event: name, validator, broadcast: options?.broadcast };
}

/**
 * Define the chunk shape a stream yields.
 */
export function chunks<TChunks>(marker: TypeMarker<TChunks>): StreamChunksDeclaration<TChunks> {
  return { chunks: marker };
}

/** Dependency ref — use in `dependencies: [stream]` to assert it's registered. */
stream.__key = STREAM_KEY;

/** Dependency ref — use in `dependencies: [generate]` to assert it's registered. */
generate.__key = GENERATE_KEY;
