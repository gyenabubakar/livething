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

/**
 * What LiveThing sends to a client as an event payload, a stream chunk, a server request or a
 * reply: a plain object, such as `{ text: 'hi' }`. LiveThing refuses `null`, a primitive and
 * an array when it sends, so the types refuse them too. An array, a `Map` or a `Set` has
 * `Symbol.iterator`, which is how the type tells it apart from a plain object.
 */
export type PayloadObject = object & { readonly [Symbol.iterator]?: never };

/**
 * What a client receives for one chunk of a cursor or recorded stream. Those streams send a
 * plain object chunk as it is, and wrap any other chunk (a primitive, `null`, an array) as
 * `{ value: chunk }`. It applies to each member of a union, as the runtime decides per chunk.
 */
export type DurableWireChunk<T> = unknown extends T
  ? T
  : T extends readonly unknown[]
    ? { value: T }
    : T extends object
      ? T
      : { value: T };
