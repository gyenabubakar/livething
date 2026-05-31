/* oxlint-disable @typescript-eslint/no-explicit-any -- type-level variance requires `any` for primitive generics in conditional types */
import type { SocketConfig } from '~/internal/config.ts';
import type { PrimitiveHelpers, PrimitiveRuntime } from '~/internal/runtime.ts';
import type { Simplify } from '~/types.ts';

// ---------------------------------------------------------------------------
// HKT — the "type function" pattern
// ---------------------------------------------------------------------------

/**
 * Base interface for primitive type functions.
 *
 * TypeScript doesn't support higher-kinded types (a type that takes another
 * type as a parameter and returns a new type). This pattern is the workaround.
 * Think of it as a function from type to type:
 *
 * - `_contract` — the "parameter" slot. Holds `unknown` by default, but `Apply`
 *   overrides it with the actual socket contract via intersection.
 * - `_api` — the "return value". Computes the methods this primitive exposes.
 *   Because `_api` can reference `this['_contract']`, it reactively updates when
 *   `_contract` is overridden.
 *
 * For primitives whose API depends on the contract (like `channels`), `_api`
 * reads from `this['_contract']`. For static APIs, use `StaticApi<{ ... }>`.
 */
export interface TypeFn {
  /** The input slot — overridden by `Apply` with the real contract. */
  readonly _contract: unknown;
  /** The output slot — computes the primitive's API surface from `_contract`. */
  readonly _api: unknown;
}

/** A type function that adds nothing to the socket — for config-only primitives. */
export interface EmptyTypeFn extends TypeFn {
  readonly _api: {};
}

/**
 * "Call" a type function: override its `_contract` with `Contract`, read `_api`.
 *
 * Intersecting `F` with `{ _contract: Contract }` makes `_contract` resolve to
 * `Contract` for reads, then we index into `_api`, which now computes against
 * the new contract.
 */
export type Apply<F extends TypeFn, Contract> = (F & { readonly _contract: Contract })['_api'];

// ---------------------------------------------------------------------------
// Primitive descriptor
// ---------------------------------------------------------------------------

/**
 * The tagged object a primitive factory returns. `client()` collects these,
 * deduplicates by `_tag`, resolves dependency order, builds the internal
 * options bag, and installs runtime behavior.
 *
 * `_typeFn` and `_requires` are phantom (type-only) slots used by the inference
 * utilities below — they carry no runtime value.
 */
export interface PrimitiveDescriptor<F extends TypeFn = EmptyTypeFn, TRequires = {}> {
  /** Unique tag identifying the primitive kind (e.g. `'connect'`, `'channels'`). */
  readonly _tag: string;
  /** Other primitive tags this one depends on, for auto-sorting. */
  readonly dependencies?: readonly string[];
  /** Phantom slot carrying the primitive's type function. @internal */
  readonly _typeFn?: F;
  /** Phantom slot carrying contract requirements. @internal */
  readonly _requires?: TRequires;
  /** Arbitrary primitive configuration consumed by `client()`. @internal */
  readonly config?: unknown;
}

/**
 * The runtime-bearing descriptor a primitive factory actually returns. Extends
 * the type-only `PrimitiveDescriptor` with the hooks `client()` uses to build
 * the socket. The extra fields are invisible to the type-inference utilities,
 * which only read `_tag` / `_typeFn` / `_requires`.
 */
export interface PrimitiveSpec<
  F extends TypeFn = EmptyTypeFn,
  TRequires = {},
> extends PrimitiveDescriptor<F, TRequires> {
  /** Merge this primitive's settings into the resolved config bag. */
  applyConfig?: (config: SocketConfig) => void;
  /** Build the runtime side (hooks + install) once the socket exists. */
  setup?: (helpers: PrimitiveHelpers) => PrimitiveRuntime;
}

// ---------------------------------------------------------------------------
// Primitive tuple resolution
// ---------------------------------------------------------------------------

/**
 * Walk a tuple of primitives, apply each one's type function with the contract,
 * and intersect all the resulting APIs.
 *
 * `[Channels, RequestResponse, Stream]` with contract `T` produces:
 * `Apply<ChannelsTypeFn, T> & Apply<RequestResponseTypeFn, T> & Apply<StreamTypeFn, T>`.
 */
export type ApplyPrimitives<
  TPrimitives extends readonly PrimitiveDescriptor<any, any>[],
  TContract,
> = TPrimitives extends readonly [
  infer Head extends PrimitiveDescriptor<any, any>,
  ...infer Rest extends PrimitiveDescriptor<any, any>[],
]
  ? Apply<NonNullable<Head['_typeFn']>, TContract> & ApplyPrimitives<Rest, TContract>
  : {};

/**
 * Validate that each primitive's requirements are satisfied by the contract.
 * If a primitive's `_requires` isn't met, its slot becomes `never` — nothing is
 * assignable to `never`, so TypeScript errors at the offending primitive.
 *
 * This is a homomorphic mapped tuple (not a recursive conditional) so it
 * preserves tuple length and lets TypeScript reverse-infer `TPrimitives` from
 * a variadic rest parameter — keeping argument-count inference intact.
 */
export type ValidatePrimitives<
  TContract,
  TPrimitives extends readonly PrimitiveDescriptor<any, any>[],
> = {
  [I in keyof TPrimitives]: TContract extends NonNullable<TPrimitives[I]['_requires']>
    ? TPrimitives[I]
    : never;
};

/** The final socket type: base socket merged with all primitive APIs, simplified. */
export type SocketWithPrimitives<
  TContract,
  TPrimitives extends readonly PrimitiveDescriptor<any, any>[],
  TBase,
> = Simplify<TBase & ApplyPrimitives<TPrimitives, TContract>>;
