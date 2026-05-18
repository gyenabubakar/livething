/* oxlint-disable @typescript-eslint/no-explicit-any */
import { assertNonReservedEventName } from '~/_engine/compile/utils.ts';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { Validator } from '~/types.ts';

/**
 * Contract-side declaration of a client→server event. Produced by `incoming()`
 * and matched to a handler later via `implement(contract).on(name, ...)`.
 */
export interface IncomingDef<TName extends string = string, TPayload = unknown> {
  readonly _: 'incoming';
  readonly name: TName;
  readonly schema?: Validator<TPayload>;
}

/**
 * Declare a client→server event with an optional schema. Use it in a contract's
 * `definitions` array; bind the handler later via `implement(contract).on(name, ...)`.
 *
 * @example
 * ```ts
 * import { contract, incoming, implement } from '@wskit/server';
 * import * as v from 'valibot';
 *
 * const c = contract('chat', {
 *   definitions: [incoming('send-msg', v.object({ text: v.string() }))],
 * });
 *
 * implement(c).on('send-msg', (ctx, payload) => { ... });
 * ```
 */
export function incoming<TName extends string>(name: TName): IncomingDef<TName, unknown>;
export function incoming<TName extends string, TPayload>(
  name: TName,
  schema: (value: unknown) => TPayload,
): IncomingDef<TName, TPayload>;
export function incoming<TName extends string, TSchema extends StandardSchemaV1>(
  name: TName,
  schema: TSchema,
): IncomingDef<TName, StandardSchemaV1.InferOutput<TSchema>>;
export function incoming<TName extends string, TPayload>(
  name: TName,
  schema: Validator<TPayload>,
): IncomingDef<TName, TPayload>;
export function incoming(name: string, schema?: Validator): IncomingDef {
  assertNonReservedEventName(name, 'incoming');
  return { _: 'incoming', name, schema };
}
