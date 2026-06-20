/* oxlint-disable @typescript-eslint/no-explicit-any */
import {
  assertNonReservedEventName,
  assertValidHighWaterMark,
  collectUnique,
} from '~/_engine/compile/utils.ts';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { TypeMarker } from '~/_api/definitions.ts';
import type { Validator } from '~/types.ts';

/**
 * Contract-side declaration of a single nudge — a client→server signal that
 * flows into an active stream as the value of `yield`. Produced by `nudge()`
 * and used inside a `stream(...)` definition.
 */
export interface NudgeDef<TName extends string = string, TPayload = unknown> {
  readonly _: 'nudge';
  readonly name: TName;
  readonly schema?: Validator<TPayload>;
}

/**
 * Contract-side declaration of a server-pushed stream. Produced by `stream()`.
 * The matching generator is registered via
 * `base.stream(name, { async *run(ctx, input) { ... } })`.
 */
export interface StreamDef<
  TName extends string = string,
  TPayload = unknown,
  TChunk = unknown,
  TNudges extends readonly NudgeDef<string, any>[] = readonly NudgeDef<string, any>[],
> {
  readonly _: 'stream';
  readonly name: TName;
  readonly payload?: Validator<TPayload>;
  readonly chunk?: TypeMarker<TChunk>;
  readonly nudges: TNudges;
  readonly broadcast: boolean;
  readonly allowConcurrent: boolean;
  readonly highWaterMark?: number;
}

/**
 * Declare a single nudge — a client→server signal that flows into an active
 * stream as the value of `yield`. Use inside a `stream(...)` definition.
 */
export function nudge<TName extends string>(name: TName): NudgeDef<TName, unknown>;
export function nudge<TName extends string, TSchema extends StandardSchemaV1>(
  name: TName,
  schema: TSchema,
): NudgeDef<TName, StandardSchemaV1.InferOutput<TSchema>>;
export function nudge(name: string, schema?: Validator): NudgeDef {
  return { _: 'nudge', name, schema };
}

/**
 * Declare a server-pushed stream. The generator is registered via
 * `base.stream(name, { async *run(ctx, input) { ... } })`.
 */
export function stream<
  TName extends string,
  TPayload = unknown,
  TChunk = unknown,
  const TNudges extends readonly NudgeDef<string, any>[] = readonly [],
>(
  name: TName,
  config?: {
    payload?: Validator<TPayload>;
    chunk?: TypeMarker<TChunk>;
    nudges?: TNudges;
    broadcast?: boolean;
    allowConcurrent?: boolean;
    highWaterMark?: number;
  },
): StreamDef<TName, TPayload, TChunk, TNudges> {
  assertNonReservedEventName(name, 'stream');
  assertValidHighWaterMark(config?.highWaterMark, `stream("${name}")`);
  const nudges = (config?.nudges ?? []) as TNudges;
  collectUnique(nudges, (n) => n.name, { kind: 'nudge', context: `stream("${name}")` });
  return {
    _: 'stream',
    name,
    payload: config?.payload,
    chunk: config?.chunk,
    nudges,
    broadcast: config?.broadcast ?? false,
    allowConcurrent: config?.allowConcurrent ?? false,
    highWaterMark: config?.highWaterMark,
  };
}
