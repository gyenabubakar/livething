/* oxlint-disable @typescript-eslint/no-explicit-any */
import { collectUnique } from '~/_engine/compile/utils.ts';
import { assertNonReservedEventName } from '~/event-name.ts';
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

interface StreamConfig<TPayload, TNudges extends readonly NudgeDef<string, any>[]> {
  payload?: Validator<TPayload>;
  nudges?: TNudges;
  broadcast?: boolean;
  allowConcurrent?: boolean;
}

/**
 * Contract-side declaration of a server-pushed stream. Produced by `stream()`.
 * The matching generator is registered via
 * `base.stream(name, { async *run(ctx, input) { ... } })`.
 */
export interface StreamDef<
  TName extends string = string,
  TPayload = unknown,
  TNudges extends readonly NudgeDef<string, any>[] = readonly NudgeDef<string, any>[],
> {
  readonly _: 'stream';
  readonly name: TName;
  readonly payload?: Validator<TPayload>;
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
 * Declare a server-pushed stream. The generator is registered via
 * `base.stream(name, { async *run(ctx, input) { ... } })`.
 */
export function stream<
  TName extends string,
  TPayload = unknown,
  const TNudges extends readonly NudgeDef<string, any>[] = readonly [],
>(name: TName, config?: StreamConfig<TPayload, TNudges>): StreamDef<TName, TPayload, TNudges> {
  assertNonReservedEventName(name, 'stream');
  const nudges = (config?.nudges ?? []) as TNudges;
  collectUnique(nudges, (n) => n.name, { kind: 'nudge', context: `stream("${name}")` });

  return {
    _: 'stream',
    name,
    payload: config?.payload,
    nudges,
    broadcast: config?.broadcast ?? false,
    allowConcurrent: config?.allowConcurrent ?? false,
  };
}
