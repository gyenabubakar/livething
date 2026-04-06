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
 *
 * ```ts
 * stream(
 *   start('ask-ai', AskAIValidator),
 *   nudge('cancel'),
 *   nudge('add-context', AddContextValidator),
 * )
 * ```
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
export type StreamNudgesApi<TNudges extends readonly NudgeDeclaration[]> = {
  nudges(value: unknown): StreamNudgeMessages<TNudges>;
};

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
 * `generate()` just carries the generator type through. `defineServer()`
 * gives `ctx` its final type later based on what is registered in the
 * same scope.
 */
export type GeneratorFn<TCtx = any, TPayload = unknown, TChunks = unknown, TNext = any> = {
  bivarianceHack(ctx: TCtx, payload: TPayload): AsyncGenerator<TChunks, void, TNext>;
}['bivarianceHack'];

// ---------------------------------------------------------------------------
// Stream start identity
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

/** Back-compat type alias while the API settles. */
export type StreamEventDeclaration<
  TEvent extends string = string,
  TPayload = unknown,
> = StreamStartDeclaration<TEvent, TPayload>;

// ---------------------------------------------------------------------------
// StreamPrimitive — contract only
// ---------------------------------------------------------------------------

/**
 * The primitive instance returned by `stream()`. Carries the event name,
 * trigger validator, and nudge declarations.
 *
 * `InferClientType` reads this together with the matching `generate(...)`
 * primitive to produce the client's `streams` type.
 */
export interface StreamPrimitive<
  TEvent extends string = string,
  TPayload = unknown,
  TNudges extends readonly NudgeDeclaration[] = readonly NudgeDeclaration[],
> extends Primitive<'stream'> {
  readonly event: TEvent;
  readonly nudges: TNudges;
  readonly validator?: Validator<TPayload>;
  readonly broadcast: boolean;
}

// ---------------------------------------------------------------------------
// GeneratePrimitive — stream generator registration
// ---------------------------------------------------------------------------

/**
 * The primitive instance returned by `generate()`. Carries the event name,
 * async generator, and chunk type. `defineServer()` matches it to the
 * sibling `stream(...)` primitive by event name.
 */
export interface GeneratePrimitive<
  TEvent extends string = string,
  TPayload = unknown,
  TChunks = unknown,
  TNudges extends readonly NudgeDeclaration[] = readonly NudgeDeclaration[],
  TBaseCtx = any,
  TNext = any,
> extends Primitive<'generate'> {
  readonly event: TEvent;
  readonly generator: GeneratorFn<
    StreamHandlerContext<TBaseCtx, TNudges>,
    TPayload,
    TChunks,
    TNext
  >;
  readonly chunks: TypeMarker<TChunks>;
}

// ---------------------------------------------------------------------------
// Runtime factories
// ---------------------------------------------------------------------------

const STREAM_KEY = Symbol('stream');
const GENERATE_KEY = Symbol('generate');

const _stream = definePrimitive<
  'stream',
  [startDecl: StreamStartDeclaration, ...nudges: NudgeDeclaration[]],
  {
    event: string;
    nudges: readonly NudgeDeclaration[];
    validator?: Validator;
    broadcast: boolean;
  }
>({
  tag: 'stream' as const,
  key: STREAM_KEY,
  kind: 'handler' as const,
  registrationId(startDecl: StreamStartDeclaration) {
    return startDecl.event;
  },
  create(startDecl: StreamStartDeclaration, ...nudges: NudgeDeclaration[]) {
    return {
      event: startDecl.event,
      nudges,
      validator: startDecl.validator,
      broadcast: startDecl.broadcast ?? false,
    };
  },
});

const _generate = definePrimitive<
  'generate',
  [event: string, generator: GeneratorFn, options: { chunks: TypeMarker<unknown> }],
  {
    event: string;
    generator: GeneratorFn;
    chunks: TypeMarker<unknown>;
  }
>({
  tag: 'generate' as const,
  key: GENERATE_KEY,
  kind: 'handler' as const,
  registrationId(event: string) {
    return event;
  },
  create(event: string, generator: GeneratorFn, options: { chunks: TypeMarker<unknown> }) {
    return {
      event,
      generator,
      chunks: options.chunks,
    };
  },
});

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Declare a stream contract. This defines the trigger event, trigger
 * validator, and optional nudges. Pair it with a sibling
 * `generate(event, fn, { chunks })` primitive in `defineServer(...)`.
 *
 * ```ts
 * stream(
 *   start('ask-ai', AskAIValidator),
 *   nudge('add-context', AddContextValidator),
 *   nudge('cancel', CancelValidator),
 * )
 *
 * generate(
 *   'ask-ai',
 *   async function* (ctx, payload) {
 *     const nudges = ctx.nudges(yield { text: payload.prompt });
 *   },
 *   { chunks: t<{ text: string }>() },
 * )
 * ```
 */
export function stream<
  TEvent extends string,
  TPayload,
  const TNudges extends readonly NudgeDeclaration[],
>(
  startDecl: StreamStartDeclaration<TEvent, TPayload>,
  ...nudges: TNudges
): StreamPrimitive<TEvent, TPayload, TNudges>;
export function stream(
  startDecl: StreamStartDeclaration,
  ...nudges: NudgeDeclaration[]
): StreamPrimitive {
  return _stream(startDecl, ...nudges) as unknown as StreamPrimitive;
}

/**
 * Register the async generator for a stream declared by a sibling
 * `stream(...)` primitive. The event name is the join key.
 *
 * ```ts
 * generate(
 *   'ask-ai',
 *   async function* (ctx, payload) {
 *     yield { text: payload.prompt };
 *   },
 *   { chunks: t<{ text: string }>() },
 * )
 * ```
 */
export function generate<
  TBaseCtx,
  TEvent extends string,
  TPayload,
  TChunks,
  const TNudges extends readonly NudgeDeclaration[] = readonly NudgeDeclaration[],
  TNext = any,
>(
  event: TEvent,
  generator: GeneratorFn<StreamHandlerContext<TBaseCtx, TNudges>, TPayload, TChunks, TNext>,
  options: { chunks: TypeMarker<TChunks> },
): GeneratePrimitive<TEvent, TPayload, TChunks, TNudges, TBaseCtx, TNext>;
export function generate(
  event: string,
  generator: GeneratorFn,
  options: { chunks: TypeMarker<unknown> },
): GeneratePrimitive {
  return _generate(event, generator, options) as unknown as GeneratePrimitive;
}

/**
 * Define the stream's start identity — the event name, trigger validator,
 * and optional broadcast flag.
 *
 * ```ts
 * start('ask-ai', AskAIValidator)
 * start('ask-ai', AskAIValidator, { broadcast: true })
 * ```
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

/** Dependency ref — use in `dependencies: [stream]` to assert it's registered. */
stream.__key = STREAM_KEY;

/** Dependency ref — use in `dependencies: [generate]` to assert it's registered. */
generate.__key = GENERATE_KEY;
