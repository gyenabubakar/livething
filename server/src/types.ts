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
 * iterable or not, because JSON sends what that returns. An array is refused even with a
 * `toJSON()`.
 */
export type PayloadObject =
  | (PlainObject & { readonly toJSON?: JsonToObject | NotAFunction })
  | (NotCallableOrBoxed & NotArray & { toJSON: JsonToObject });

/**
 * Not a function, and not a boxed `Number`, `String` or `Boolean` (JSON unboxes `new Number(7)`
 * to `7`). Each has a method that a plain object lacks: `Symbol.hasInstance`, `toFixed`,
 * `charAt`, or a `valueOf()` that returns a boolean. A data field with one of these names is
 * fine, because only the method marks a function or a boxed value.
 */
type NotCallableOrBoxed = object & {
  readonly [Symbol.hasInstance]?: never;
  readonly toFixed?: NotAFunction;
  readonly charAt?: NotAFunction;
  readonly valueOf?:
    | NotAFunction
    | (() => object | string | number | bigint | symbol | null | undefined);
};

/** Any value but a function. A function has `Symbol.hasInstance`, which no other value has. */
type NotAFunction =
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined
  | { readonly [Symbol.hasInstance]?: never };

/**
 * An object that is not an iterable (arrays, `Map`, `Set`, async generators), a function or a
 * boxed value. An iterable has `Symbol.iterator` or `Symbol.asyncIterator`, which a plain object
 * lacks.
 */
type PlainObject = NotCallableOrBoxed & {
  readonly [Symbol.iterator]?: never;
  readonly [Symbol.asyncIterator]?: never;
};

/** Not an array. The runtime refuses every array, even one with a `toJSON()`. */
type NotArray = { readonly [Symbol.unscopables]?: never };

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
 *   arrives as `{ value: string }`). A number arrives as `number | null`, because JSON turns
 *   `NaN` and `Infinity` into `null`;
 * - a value with no JSON (a function, `undefined`, a `symbol`, a `toJSON()` that returns
 *   nothing), a `bigint` (JSON throws) or an iterable without `toJSON()` (a `Map`) is refused at
 *   runtime, so it is `never`.
 */
export type DurableWireChunk<T> = unknown extends T ? T : WireChunkOf<JsonOf<T>>;

/** What a value's `toJSON()` returns, if it has one. JSON sends that instead of the value. */
type JsonOf<T> = T extends { toJSON(...args: never[]): infer TJson } ? TJson : T;

/**
 * A value as it comes back from JSON, at every depth: what a `toJSON()` returns (a `Date` becomes
 * a `string`), with no methods, functions, `symbol` keys or `undefined` fields. In an array, a
 * value with no JSON becomes `null`. A `Map` or a `Set` becomes `{}`. A number stays `number`,
 * although JSON sends `NaN` and `Infinity` as `null`.
 */
export type Jsonify<T> = unknown extends T
  ? T
  : T extends { toJSON(...args: never[]): infer TJson }
    ? Jsonify<TJson>
    : T extends string | number | boolean | null | undefined | void
      ? T
      : T extends ReadonlyMap<unknown, unknown> | ReadonlySet<unknown>
        ? Record<string, never>
        : T extends readonly unknown[]
          ? { -readonly [K in keyof T]: JsonifyItem<T[K]> }
          : T extends object
            ? {
                [K in keyof T as K extends symbol
                  ? never
                  : HasNoJson<T[K]> extends true
                    ? never
                    : K]: Jsonify<T[K]>;
              }
            : never;

/** An array item as JSON: one with no JSON becomes `null`, for each member of a union. */
type JsonifyItem<T> = T extends ((...args: never[]) => unknown) | symbol | undefined
  ? null
  : Jsonify<T>;

/** A value that JSON leaves out of an object: a function, a `symbol` or `undefined`. */
type HasNoJson<T> = [T] extends [never]
  ? false
  : [T] extends [((...args: never[]) => unknown) | symbol | undefined]
    ? true
    : false;

/**
 * A request reply as the client's `request()` resolves it. A reply of `null` sends no payload,
 * so the client gets `undefined`.
 */
export type ClientResponse<T> = 0 extends 1 & T
  ? T
  : [T] extends [null]
    ? void
    : Jsonify<Exclude<T, null>> | (null extends T ? undefined : never);

type WireChunkOf<TJson> = TJson extends
  | undefined
  | void
  | symbol
  | bigint
  | ((...args: never[]) => unknown)
  ? never
  : TJson extends readonly unknown[]
    ? { value: Jsonify<TJson> }
    : // A boxed Number, String or Boolean (JSON unboxes it), found by a method only it has.
      TJson extends number | { toFixed(...args: never[]): string }
      ? { value: number | null }
      : TJson extends string | { charAt(...args: never[]): string }
        ? { value: string }
        : TJson extends boolean | { valueOf(): boolean }
          ? { value: boolean }
          : TJson extends object
            ? TJson extends Iterable<unknown>
              ? never
              : Jsonify<TJson>
            : { value: TJson };
