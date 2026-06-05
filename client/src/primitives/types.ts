/* oxlint-disable @typescript-eslint/no-explicit-any -- the type-level machinery needs `any` to stay generic */
import type { SocketConfig } from '~/internal/config.ts';
import type { PrimitiveHelpers, PrimitiveRuntime } from '~/internal/runtime.ts';
import type { Simplify } from '~/types.ts';

/**
 * A "type function" — a type that takes the socket contract and returns the API
 * a primitive adds to the socket.
 *
 * TypeScript can't pass a type to a type the way you pass a value to a function,
 * so we fake it with two slots: `_contract` is the input and `_api` is the
 * output. `Apply` fills in `_contract`, then reads `_api`. Because `_api` can
 * reference `this['_contract']`, it recomputes against whatever contract is
 * plugged in.
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
 * Run a type function: plug `Contract` into its `_contract` slot and read the
 * resulting `_api`.
 */
export type Apply<F extends TypeFn, Contract> = (F & { readonly _contract: Contract })['_api'];

/**
 * What a primitive factory (like `channels()` or `reconnection()`) returns.
 *
 * `client()` reads these to build the socket. The `_typeFn` and `_requires`
 * fields exist only for the type system (they hold no value at runtime);
 * `applyConfig` and `setup` are the runtime wiring.
 */
export interface Primitive<F extends TypeFn = EmptyTypeFn, TRequires = {}> {
  /** Names the primitive (e.g. `'connect'`, `'channels'`). Used to catch duplicates. */
  readonly _tag: string;
  /**
   * Set by `plugin()` — marks this spec as a plugin, not a built-in primitive.
   * Plugins live in their own identity space (keyed by `key` + `registrationId`)
   * and always run after every primitive.
   */
  readonly _plugin?: {
    readonly key: symbol;
    readonly id: string;
    readonly registrationId?: string;
  };
  /** Other primitives this one must run after. */
  readonly dependencies?: readonly string[];
  /**
   * Other primitives this one should run after when they're present, without
   * requiring them. Unlike `dependencies`, a missing entry is fine — it only
   * affects ordering, never the presence check.
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
 * Walk the list of primitives, run each one's type function against the
 * contract, and merge all the resulting APIs together. This is how the socket
 * type gains `.channel()`, `.request()`, and so on.
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
 * Check that each primitive's `_requires` is met by the contract. A primitive
 * that isn't satisfied becomes `never` in the list, and since you can't pass a
 * real value where `never` is expected, TypeScript flags that exact argument.
 *
 * This is a mapped tuple (not recursion) on purpose: it keeps the tuple length,
 * which lets TypeScript still infer the primitives from a `...rest` argument.
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
 * A type-level error. The method exists but is deliberately NOT callable, so
 * calling it fails on the method itself (not on an argument) with:
 *   "This expression is not callable. Type '{ error: "[wskit] …" }' has no call
 *    signatures."
 * The wrapping object keeps the message from widening to `string`, and using it
 * as a value (not a key) keeps punctuation like the em-dash intact.
 */
type NeedsPrimitive<Message extends string> = { error: Message };

/**
 * True when the contract genuinely declares this section with named events. It
 * must be a required key (an optional `channels?:` is excluded, because the
 * primitive's own `_requires` won't accept an optional section — so suggesting
 * it would be a dead end), it must be non-empty, and it must not be the base
 * `SocketContract`'s bare index signature (so the default contract never gets a
 * spurious stub).
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
 * For a contract section that needs a primitive you forgot to install, add a
 * stub method whose call signature carries a readable "add X() to client()"
 * message. The check is whether the installed API already provides the method
 * (not which `_tag`s were passed), so it works no matter what else is installed.
 * When the primitive IS installed, nothing is added and the real method (from
 * `ApplyPrimitives`) stands alone — so the happy path is untouched.
 */
export type MissingPrimitiveStubs<TContract, TPrimitives extends readonly Primitive<any, any>[]> =
  ApplyPrimitives<TPrimitives, TContract> extends infer Api
    ? (SectionDeclared<TContract, 'channels'> extends true
        ? 'channel' extends keyof Api
          ? {}
          : {
              channel: NeedsPrimitive<'[wskit] socket.channel needs the channels() primitive — add channels() to client()'>;
            }
        : {}) &
        (SectionDeclared<TContract, 'namespaces'> extends true
          ? 'namespace' extends keyof Api
            ? {}
            : {
                namespace: NeedsPrimitive<'[wskit] socket.namespace needs the namespaces() primitive — add namespaces() to client()'>;
              }
          : {}) &
        (SectionDeclared<TContract, 'requests'> extends true
          ? 'request' extends keyof Api
            ? {}
            : {
                request: NeedsPrimitive<'[wskit] socket.request needs the requestResponse() primitive — add requestResponse() to client()'>;
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
