/* oxlint-disable @typescript-eslint/no-explicit-any */
import { assertNonReservedEventName } from '~/event-name.ts';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { Validator } from '~/types.ts';

/**
 * Contract-side declaration of a client→server event. Produced internally when
 * you register a handler with `base.on(name, ...)`.
 */
export interface IncomingDef<TName extends string = string, TPayload = unknown> {
  readonly _: 'incoming';
  readonly name: TName;
  readonly schema?: Validator<TPayload>;
}

/**
 * Declare a client→server event with an optional schema. This is the internal
 * builder behind `base.on(name, ...)`, which both declares the event and binds
 * its handler.
 *
 * @example
 * ```ts
 * import { define, t } from '@wskit/server';
 * import * as v from 'valibot';
 *
 * const base = define({});
 *
 * const handleSend = base.on('send-msg', {
 *   input: v.object({ text: v.string() }),
 *   run(ctx, input) { ... },
 * });
 * base.assemble({ handlers: [handleSend] });
 * ```
 */
export function incoming<TName extends string>(name: TName): IncomingDef<TName, unknown>;
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
