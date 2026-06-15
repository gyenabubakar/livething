/* oxlint-disable @typescript-eslint/no-explicit-any -- the type-level machinery needs `any` to stay generic */
import type { SocketConfig } from '~/internal/config.ts';
import type { PrimitiveHelpers, PrimitiveRuntime } from '~/internal/runtime.ts';
import type { Simplify } from '~/types.ts';

/**
 * A "type function" — a type that takes a socket contract and returns the API
 * a primitive adds to the socket.
 *
 * TypeScript can't pass a type as an argument to another type the way you pass
 * a value to a function. We work around that with two slots: `_contract` (the
 * input) and `_api` (the output). `Apply` fills `_contract` in and then reads
 * `_api`. Because `_api` can reference `this['_contract']`, it changes based on
 * whatever contract is plugged in.
 */
export interface TypeFn {
  readonly _contract: unknown;
  readonly _api: unknown;
}

/** A type function that adds nothing — for primitives that only configure or hook. */
export interface EmptyTypeFn extends TypeFn {
  readonly _api: {};
}

/**
 * Run a type function: set `_contract` to `Contract` and read back `_api`.
 */
export type Apply<F extends TypeFn, Contract> = (F & { readonly _contract: Contract })['_api'];

/**
 * What a primitive factory (like `channels()` or `reconnection()`) returns.
 *
 * `client()` reads these to build the socket. `_typeFn` and `_requires` are
 * type-only fields (no runtime value); `applyConfig` and `setup` are what
 * actually run.
 */
export interface Primitive<F extends TypeFn = EmptyTypeFn, TRequires = {}> {
  /** Names the primitive (e.g. `'connect'`, `'channels'`). Used to catch duplicates. */
  readonly _tag: string;
  /**
   * Set by `plugin()` — marks this as a plugin, not a built-in primitive.
   * Plugins are tracked by `key` + `registrationId` and always run after all
   * primitives.
   */
  readonly _plugin?: {
    readonly key: symbol;
    readonly id: string;
    readonly registrationId?: string;
  };
  /** Other primitives this one must run after. */
  readonly dependencies?: readonly string[];
  /**
   * Like `dependencies`, but optional — run after these if they're present,
   * don't fail if they're not. Only affects ordering.
   */
  readonly optionalAfter?: readonly string[];
  /** Type-only: the API this primitive adds to the socket. */
  readonly _typeFn?: F;
  /** Type-only: what the contract must contain for this primitive to be valid. */
  readonly _requires?: TRequires;
  /** Copy this primitive's settings into the shared config the kernel reads. */
  applyConfig?: (config: SocketConfig) => void;
  /** Build the runtime behavior once the socket exists. */
  setup?: (helpers: PrimitiveHelpers) => PrimitiveRuntime;
}

/**
 * Run each primitive's type function against the contract and merge the
 * results. This is how the socket type gains `.channel()`, `.request()`, etc.
 */
export type ApplyPrimitives<
  TPrimitives extends readonly Primitive<any, any>[],
  TContract,
> = TPrimitives extends readonly [
  infer Head extends Primitive<any, any>,
  ...infer Rest extends Primitive<any, any>[],
]
  ? Apply<NonNullable<Head['_typeFn']>, TContract> & ApplyPrimitives<Rest, TContract>
  : {};

/**
 * Check that each primitive's `_requires` is satisfied by the contract. A
 * primitive whose requirement isn't met becomes `never`, so TypeScript will
 * flag that exact argument at the call site.
 *
 * Uses a mapped tuple instead of recursion to preserve the tuple length,
 * which lets TypeScript infer the primitives from a `...rest` argument.
 */
export type ValidatePrimitives<TContract, TPrimitives extends readonly Primitive<any, any>[]> = {
  [I in keyof TPrimitives]: TContract extends NonNullable<TPrimitives[I]['_requires']>
    ? TPrimitives[I]
    : never;
};

/** The final socket type: the base socket plus every primitive's API, flattened. */
export type SocketWithPrimitives<
  TContract,
  TPrimitives extends readonly Primitive<any, any>[],
  TBase,
> = Simplify<TBase & ApplyPrimitives<TPrimitives, TContract>>;

/**
 * A type-level error hint. The method exists but is not callable, so calling
 * it shows a message like:
 *   "This expression is not callable. Type '{ error: "[wskit] …" }' has no
 *    call signatures."
 * The object wrapper stops TypeScript from widening the message to `string`,
 * and putting it as a value (not a key) keeps the em-dash and other punctuation.
 */
type NeedsPrimitive<Message extends string> = { error: Message };

/**
 * True when the contract actually declares this section with named events.
 * - Excludes optional sections (e.g. `channels?:`) because `_requires` won't
 *   accept them, so a stub there would just mislead.
 * - Excludes empty sections and bare index signatures (`[key: string]: ...`)
 *   so the default contract never gets a spurious stub.
 */
type SectionDeclared<TContract, Section extends string> = Section extends keyof TContract
  ? {} extends Pick<TContract, Section>
    ? false
    : keyof NonNullable<TContract[Section]> extends never
      ? false
      : string extends keyof NonNullable<TContract[Section]>
        ? false
        : true
  : false;

/**
 * True when the contract declares at least one scoped section that needs a
 * primitive. A plain incoming/outgoing contract declares none, so the whole
 * stub computation below is skipped — no `ApplyPrimitives` re-binding and no
 * per-section checks on the common case.
 */
type AnyScopedSectionDeclared<TContract> =
  SectionDeclared<TContract, 'channels'> extends true
    ? true
    : SectionDeclared<TContract, 'requests'> extends true
      ? true
      : SectionDeclared<TContract, 'serverRequests'> extends true
        ? true
        : SectionDeclared<TContract, 'streams'> extends true
          ? true
          : false;

/**
 * If a contract section needs a primitive that wasn't installed, add a stub
 * method that shows a clear "add X() to client()" error when called. The check
 * is whether the method already exists in the API (not which `_tag`s were
 * passed), so it's independent of install order. When the primitive is present,
 * nothing is added — the real method stands alone.
 */
export type MissingPrimitiveStubs<TContract, TPrimitives extends readonly Primitive<any, any>[]> =
  AnyScopedSectionDeclared<TContract> extends false
    ? {}
    : ApplyPrimitives<TPrimitives, TContract> extends infer Api
      ? (SectionDeclared<TContract, 'channels'> extends true
          ? 'channel' extends keyof Api
            ? {}
            : {
                channel: NeedsPrimitive<'[wskit] socket.channel needs the channels() primitive — add channels() to client()'>;
              }
          : {}) &
          (SectionDeclared<TContract, 'requests'> extends true
            ? 'request' extends keyof Api
              ? {}
              : {
                  request: NeedsPrimitive<'[wskit] socket.request needs the requestResponse() primitive — add requestResponse() to client()'>;
                }
            : {}) &
          (SectionDeclared<TContract, 'serverRequests'> extends true
            ? 'onRequest' extends keyof Api
              ? {}
              : {
                  onRequest: NeedsPrimitive<'[wskit] socket.onRequest needs the serverRequest() primitive — add serverRequest() to client()'>;
                }
            : {}) &
          (SectionDeclared<TContract, 'streams'> extends true
            ? 'onStream' extends keyof Api
              ? {}
              : {
                  stream: NeedsPrimitive<'[wskit] socket.stream needs the stream() primitive — add stream() to client()'>;
                  onStream: NeedsPrimitive<'[wskit] socket.onStream needs the stream() primitive — add stream() to client()'>;
                  resumeStream: NeedsPrimitive<'[wskit] socket.resumeStream needs the stream() primitive — add stream() to client()'>;
                }
            : {})
      : {};
