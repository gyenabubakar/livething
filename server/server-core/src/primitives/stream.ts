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
 *   generate(async function* (ctx, payload) {
 *     const nudges = ctx.nudges(yield { text: 'token' });
 *     for (const { event, payload: data } of nudges) {
 *       if (event === 'cancel') return;
 *     }
 *   }, { chunks: t<{ text: string }>() }),
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
// Generate — the async generator handler
// ---------------------------------------------------------------------------

/**
 * A nudge message passed to the generator.
 */
export interface NudgeMessage<TEvent extends string = string, TPayload = unknown> {
  readonly event: TEvent;
  readonly payload: TPayload;
}

/**
 * The async generator function for a stream. Receives context and the
 * validated trigger payload. Yields chunks to the client.
 *
 * `generate()` just carries the generator type through. `defineServer()`
 * gives `ctx` its final type later based on what is registered in the
 * same scope.
 */
export type GeneratorFn<TCtx = any, TPayload = unknown, TChunks = unknown, TNext = any> = (
  ctx: TCtx,
  payload: TPayload,
) => AsyncGenerator<TChunks, void, TNext>;

/**
 * The generate declaration. Carries the async generator function and
 * the chunk type marker.
 */
export interface GenerateDeclaration<
  TCtx = any,
  TPayload = unknown,
  TChunks = unknown,
  TNext = any,
> {
  readonly fn: GeneratorFn<TCtx, TPayload, TChunks, TNext>;
  readonly chunks: TypeMarker<TChunks>;
}

/**
 * Define the async generator handler for a stream. The generator yields
 * chunks to the client. The `chunks` option declares the chunk shape
 * via `t<Type>()`.
 *
 * ```ts
 * generate(async function* (ctx, payload) {
 *   for await (const token of callLLM(payload.prompt)) {
 *     yield { text: token };
 *   }
 * }, { chunks: t<{ text: string }>() })
 * ```
 */
export function generate<TCtx, TPayload, TChunks, TNext = any>(
  fn: GeneratorFn<TCtx, TPayload, TChunks, TNext>,
  options: { chunks: TypeMarker<TChunks> },
): GenerateDeclaration<TCtx, TPayload, TChunks, TNext> {
  return { fn, chunks: options.chunks };
}

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
// StreamPrimitive — what stream() returns
// ---------------------------------------------------------------------------

/**
 * The primitive instance returned by `stream()`. Carries the event name,
 * generator, chunk type, nudge declarations, and trigger validator.
 *
 * `InferClientType` reads this to produce the client's `streams` type with
 * `payload` (trigger), `chunks` (what the generator yields), and optional
 * `nudges` (mid-stream events the client can send).
 */
export interface StreamPrimitive<
  TEvent extends string = string,
  TPayload = unknown,
  TChunks = unknown,
  TNudges extends readonly NudgeDeclaration[] = readonly NudgeDeclaration[],
  TCtx = any,
> extends Primitive<'stream'> {
  readonly event: TEvent;
  readonly generator: GeneratorFn<TCtx, TPayload, TChunks, any>;
  readonly chunks: TypeMarker<TChunks>;
  readonly nudges: TNudges;
  readonly validator?: Validator<TPayload>;
  readonly broadcast: boolean;
}

// ---------------------------------------------------------------------------
// Runtime factory
// ---------------------------------------------------------------------------

const STREAM_KEY = Symbol('stream');

const _stream = definePrimitive({
  tag: 'stream' as const,
  key: STREAM_KEY,
  kind: 'handler' as const,
  registrationId(startDecl: StreamStartDeclaration, ..._rest: any[]) {
    return startDecl.event;
  },
  create(
    startDecl: StreamStartDeclaration,
    ...children: [...NudgeDeclaration[], GenerateDeclaration]
  ) {
    const generateDecl = children.at(-1) as GenerateDeclaration;
    const nudgeDecls = children.slice(0, -1) as NudgeDeclaration[];

    return {
      event: startDecl.event,
      generator: generateDecl.fn,
      chunks: generateDecl.chunks,
      nudges: nudgeDecls,
      validator: startDecl.validator,
      broadcast: startDecl.broadcast ?? false,
    };
  },
});

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Define a streaming handler. The stream uses the same event name for
 * triggering (client → server) and chunks (server → client). A `_streamId`
 * distinguishes them on the wire.
 *
 * ```ts
 * stream(
 *   start('ask-ai', AskAIValidator),
 *   nudge('add-context', AddContextValidator),
 *   generate(async function* (ctx, payload) {
 *     for await (const token of callLLM(payload.prompt)) {
 *       yield { text: token };
 *     }
 *   }, { chunks: t<{ text: string }>() }),
 * )
 * ```
 *
 * - `start(name, validator?)` — the stream's event name and trigger validator
 * - `nudge(event, validator?)` — optional mid-stream events (zero or more)
 * - `generate(fn, { chunks: t<Type>() })` — the async generator and chunk type
 */
export function stream<
  TCtx,
  TEvent extends string,
  TPayload,
  TChunks,
  const TNudges extends readonly NudgeDeclaration[],
  TNext = any,
>(
  startDecl: StreamStartDeclaration<TEvent, TPayload>,
  ...children: [
    ...nudges: TNudges,
    generateDecl: GenerateDeclaration<TCtx, TPayload, TChunks, TNext>,
  ]
): StreamPrimitive<TEvent, TPayload, TChunks, TNudges, TCtx>;
export function stream(
  startDecl: StreamStartDeclaration,
  ...children: [...NudgeDeclaration[], GenerateDeclaration]
): StreamPrimitive {
  return _stream(startDecl, ...children) as unknown as StreamPrimitive;
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
