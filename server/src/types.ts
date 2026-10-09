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
 * `null`, a primitive, an array, a function, an iterable such as a `Map` (JSON gives `{}`) and an
 * object whose `toJSON()` gives something else (a `Date` gives a string) when it sends, so the
 * types refuse them too. An object with a `toJSON()` that returns a plain object is accepted,
 * iterable or not, because JSON sends what that returns.
 */
export type PayloadObject =
  | (PlainObject & { readonly toJSON?: JsonToObject })
  | (NotCallableOrBoxed & { toJSON: JsonToObject });

/**
 * Not a function, and not a boxed `Number` or `String` (JSON unboxes `new Number(7)` to `7`).
 * Each has a key that a plain object lacks: `Symbol.hasInstance`, `toFixed` or `charAt`. A
 * boxed `Boolean` has no such key, so the runtime check is what refuses it.
 */
type NotCallableOrBoxed = object & {
  readonly [Symbol.hasInstance]?: never;
  readonly toFixed?: never;
  readonly charAt?: never;
};

/**
 * An object that is not an iterable (arrays, `Map`, `Set`), a function or a boxed value. An
 * iterable has `Symbol.iterator`, which a plain object lacks.
 */
type PlainObject = NotCallableOrBoxed & { readonly [Symbol.iterator]?: never };

/** A `toJSON()` that JSON calls with the root key `""` and that returns a plain object. */
type JsonToObject = (key: string) => PlainObject;

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
 * What a client receives for one chunk of a cursor or recorded stream, decided on the chunk's
 * JSON (what its `toJSON()` returns, if it has one), per member of a union as the runtime does:
 * - a plain object is sent as it is;
 * - a primitive, `null`, an array or a boxed value is wrapped as `{ value: json }` (a `Date`
 *   arrives as `{ value: string }`);
 * - a value with no JSON (a function, `undefined`) or an iterable without `toJSON()` (a `Map`) is
 *   refused at runtime, so it is `never`.
 */
export type DurableWireChunk<T> = unknown extends T ? T : WireChunkOf<JsonOf<T>>;

type JsonOf<T> = T extends { toJSON(...args: never[]): infer TJson } ? TJson : T;

type WireChunkOf<TJson> = TJson extends undefined | ((...args: never[]) => unknown)
  ? never
  : TJson extends readonly unknown[]
    ? { value: TJson }
    : // A boxed Number or String (JSON unboxes it), found by a method only it has.
      TJson extends number | { toFixed: unknown }
      ? { value: number }
      : TJson extends string | { charAt: unknown }
        ? { value: string }
        : TJson extends boolean
          ? { value: boolean }
          : TJson extends object
            ? TJson extends Iterable<unknown>
              ? never
              : TJson
            : { value: TJson };
