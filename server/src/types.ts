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
 * reply: an object that stays an object in JSON, such as `{ text: 'hi' }`. LiveThing refuses
 * `null`, a primitive, an array, a function and an object whose `toJSON()` gives something else
 * (a `Date` gives a string) when it sends, so the types refuse them too. An array and a function
 * have a key that a plain object lacks: `Symbol.iterator` or `Symbol.hasInstance`.
 */
export type PayloadObject = object & {
  readonly [Symbol.iterator]?: never;
  readonly [Symbol.hasInstance]?: never;
  readonly toJSON?: (key?: never) => object;
};

/**
 * A declared payload type as the contract records it. TypeScript's `{}` means "anything but
 * `null` and `undefined`", so `t<{}>()` would let `ctx.send(event, 'text')` compile. An empty
 * `{}` becomes `Record<string, never>`, which only an empty object matches.
 */
export type ContractPayload<T> = [keyof T] extends [never]
  ? string extends T
    ? Record<string, never>
    : T
  : T;

/**
 * What a client receives for one chunk of a cursor or recorded stream. Those streams send a
 * plain object chunk as it is (an object with `toJSON()` as what that returns), and wrap any
 * other chunk (a primitive, `null`, an array, a function, a `Date`) as `{ value: chunk }`. It applies to each member of a union, as the runtime decides per chunk.
 */
export type DurableWireChunk<T> = unknown extends T
  ? T
  : T extends readonly unknown[] | ((...args: never[]) => unknown)
    ? { value: T }
    : T extends { toJSON(...args: never[]): infer TJson }
      ? TJson extends object
        ? TJson extends readonly unknown[]
          ? { value: T }
          : TJson
        : { value: T }
      : T extends object
        ? T
        : { value: T };
