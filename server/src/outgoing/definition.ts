/* oxlint-disable @typescript-eslint/no-explicit-any */
import { assertNonReservedEventName } from '~/event-name.ts';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { TypeMarker } from '~/_api/definitions.ts';
import type { Validator } from '~/types.ts';

/** A `t<T>()` marker carries only a compile-time type — no runtime validator. */
function isTypeMarker(value: unknown): value is TypeMarker<unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as { __livething_t?: unknown }).__livething_t === 't'
  );
}

/**
 * Contract-side declaration of a server→client event. Produced internally for
 * each entry in the `emits({...})` capability and surfaced to client SDKs
 * through `InferClient`.
 */
export interface OutgoingDef<TName extends string = string, TPayload = unknown> {
  readonly _: 'outgoing';
  readonly name: TName;
  readonly schema?: Validator<TPayload>;
}

/**
 * Declare a server→client event with its payload type.
 *
 * Outgoing payloads are not validated at runtime, so pick whichever you prefer:
 * a `t<MyType>()` marker (type only, zero runtime cost) or a Standard Schema
 * (valibot/zod/etc.) when you already have one. Either way the payload type
 * flows into `InferClient` so the generated client SDK is typed.
 */
export function outgoing<TName extends string>(name: TName): OutgoingDef<TName, unknown>;
export function outgoing<TName extends string, TSchema extends StandardSchemaV1>(
  name: TName,
  schema: TSchema,
): OutgoingDef<TName, StandardSchemaV1.InferOutput<TSchema>>;
export function outgoing<TName extends string, TPayload>(
  name: TName,
  marker: TypeMarker<TPayload>,
): OutgoingDef<TName, TPayload>;
export function outgoing(
  name: string,
  schema?: StandardSchemaV1 | TypeMarker<unknown>,
): OutgoingDef {
  assertNonReservedEventName(name, 'outgoing');
  // A t<>() marker has no runtime validator — keep schema undefined for it.
  const validator = schema && !isTypeMarker(schema) ? (schema as Validator) : undefined;
  return { _: 'outgoing', name, schema: validator };
}
