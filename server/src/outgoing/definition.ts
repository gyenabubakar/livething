/* oxlint-disable @typescript-eslint/no-explicit-any */
import { assertNonReservedEventName } from '~/_engine/compile/utils.ts';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { Validator } from '~/types.ts';

/**
 * Contract-side declaration of a server→client event. Produced by `outgoing()`
 * and surfaced to client SDKs through `InferClient`.
 */
export interface OutgoingDef<TName extends string = string, TPayload = unknown> {
  readonly _: 'outgoing';
  readonly name: TName;
  readonly schema?: Validator<TPayload>;
}

/**
 * Declare a server→client event with an optional schema. The event name and
 * payload type flow into `InferClient` so the generated client SDK is typed.
 */
export function outgoing<TName extends string>(name: TName): OutgoingDef<TName, unknown>;
export function outgoing<TName extends string, TPayload>(
  name: TName,
  schema: (value: unknown) => TPayload,
): OutgoingDef<TName, TPayload>;
export function outgoing<TName extends string, TSchema extends StandardSchemaV1>(
  name: TName,
  schema: TSchema,
): OutgoingDef<TName, StandardSchemaV1.InferOutput<TSchema>>;
export function outgoing<TName extends string, TPayload>(
  name: TName,
  schema: Validator<TPayload>,
): OutgoingDef<TName, TPayload>;
export function outgoing(name: string, schema?: Validator): OutgoingDef {
  assertNonReservedEventName(name, 'outgoing');
  return { _: 'outgoing', name, schema };
}
