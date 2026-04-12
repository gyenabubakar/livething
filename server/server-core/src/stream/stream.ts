/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { Primitive } from '~/primitive.ts';
import type { Validator } from '~/types.ts';

export interface NudgeDeclaration<TEvent extends string = string, TPayload = unknown> {
  readonly event: TEvent;
  readonly validator?: Validator<TPayload>;
}

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

export interface NudgeMessage<TEvent extends string = string, TPayload = unknown> {
  readonly event: TEvent;
  readonly payload: TPayload;
}

export type StreamNudgeMessages<TNudges extends readonly NudgeDeclaration[]> = readonly {
  [TIndex in keyof TNudges]: TNudges[TIndex] extends NudgeDeclaration<infer TEvent, infer TPayload>
    ? NudgeMessage<TEvent, TPayload>
    : never;
}[number][];

export interface StreamNudgesApi<TNudges extends readonly NudgeDeclaration[]> {
  nudges(value: unknown): StreamNudgeMessages<TNudges>;
}

export type StreamHandlerContext<TBaseCtx, TNudges extends readonly NudgeDeclaration[]> = TBaseCtx &
  StreamNudgesApi<TNudges>;

export type GeneratorFn<TCtx = any, TPayload = unknown, TChunks = unknown, TNext = any> = {
  bivarianceHack(ctx: TCtx, payload: TPayload): AsyncGenerator<TChunks, void, TNext>;
}['bivarianceHack'];

export interface StreamStartDeclaration<TEvent extends string = string, TPayload = unknown> {
  readonly event: TEvent;
  readonly validator?: Validator<TPayload>;
  readonly broadcast?: boolean;
}

export interface StreamPrimitive<
  TEvent extends string = string,
  TPayload = unknown,
  _TChunks = unknown,
  TNudges extends readonly NudgeDeclaration[] = readonly NudgeDeclaration[],
> extends Primitive<'stream'> {
  readonly event: TEvent;
  readonly validator?: Validator<TPayload>;
  readonly nudges: TNudges;
  readonly broadcast: boolean;
}

type StreamPayload<TStream extends StreamPrimitive> =
  TStream extends StreamPrimitive<string, infer TPayload, any, any> ? TPayload : never;

type StreamChunks<TStream extends StreamPrimitive> =
  TStream extends StreamPrimitive<string, any, infer TChunks, any> ? TChunks : never;

type StreamNudges<TStream extends StreamPrimitive> =
  TStream extends StreamPrimitive<string, any, any, infer TNudges> ? TNudges : never;

export interface GeneratePrimitive<
  TStream extends StreamPrimitive = StreamPrimitive,
  TBaseCtx = any,
  TNext = any,
> extends Primitive<'generate'> {
  readonly stream: TStream;
  readonly event: TStream['event'];
  readonly generator: GeneratorFn<
    StreamHandlerContext<TBaseCtx, StreamNudges<TStream>>,
    StreamPayload<TStream>,
    StreamChunks<TStream>,
    TNext
  >;
}

const STREAM_KEY = Symbol('stream');
const GENERATE_KEY = Symbol('generate');

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
    __dependencies: [],
    __requires: {},
    event: startDecl.event,
    validator: startDecl.validator,
    nudges,
    broadcast: startDecl.broadcast ?? false,
  };
}

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
    __dependencies: [],
    __requires: {},
    stream: streamDecl,
    event: streamDecl.event,
    generator,
  };
}

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

stream.__key = STREAM_KEY;
generate.__key = GENERATE_KEY;
