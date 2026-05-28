/* oxlint-disable @typescript-eslint/no-explicit-any */
import { assertNonReservedEventName, collectUnique } from '~/_engine/compile/utils.ts';
import type { StandardSchemaV1 } from '@standard-schema/spec';
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
 * The matching generator is attached later via
 * `implement(contract).stream(name, async function* (ctx, payload) { ... })`.
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
  readonly chunk?: Validator<TChunk>;
  readonly nudges: TNudges;
  readonly broadcast: boolean;
  readonly allowConcurrent: boolean;
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
 * Declare a server-pushed stream. The generator is attached later via
 * `implement(contract).stream(name, async function* (ctx, payload) { ... })`.
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
    chunk?: Validator<TChunk>;
    nudges?: TNudges;
    broadcast?: boolean;
    allowConcurrent?: boolean;
  },
): StreamDef<TName, TPayload, TChunk, TNudges> {
  assertNonReservedEventName(name, 'stream');
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
  };
}
