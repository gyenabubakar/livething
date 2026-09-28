/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { StandardSchemaV1 } from '@standard-schema/spec';

/**
 * A validator for an incoming message payload — any Standard Schema (valibot,
 * zod, arktype, or any other compliant library).
 *
 * Accepted everywhere LiveThing expects validation: the `input` of `base.on`,
 * `base.request`, and `base.stream`, plus `nudges` and a channel `subscribe`
 * schema. TypeScript infers the payload type from the schema, so your handler
 * is typed automatically.
 *
 * ```ts
 * import * as v from 'valibot';
 *
 * const handleSend = base.on('send-message', {
 *   input: v.object({ text: v.string() }),
 *   run(ctx, input) { ... },
 * });
 * const handleGetUser = base.request('get-user', {
 *   input: v.object({ id: v.string() }),
 *   run(ctx, input) {
 *     return { name: 'Ada' };
 *   },
 * });
 * base.assemble({ handlers: [handleSend, handleGetUser] });
 * ```
 */
export type Validator<T = any> = StandardSchemaV1<unknown, T>;
