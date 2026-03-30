/* oxlint-disable @typescript-eslint/no-explicit-any -- type-level variance requires `any` for Plugin generics in conditional types */
import type { Plugin } from '@/plugins/base.ts';
import type { Simplify } from '@/types.ts';

// ---------------------------------------------------------------------------
// HKT — the "type function" pattern
// ---------------------------------------------------------------------------

/**
 * Base interface for plugin type functions.
 *
 * TypeScript doesn't support higher-kinded types (a type that takes another
 * type as a parameter and returns a new type). This pattern is the workaround.
 * Think of it as a function that takes a type and returns a type:
 *
 * - `_contract` — the "parameter" slot. It holds `unknown` by default, but
 *   `Apply` overrides it with the actual socket contract via intersection.
 * - `_api` — the "return value". It computes the methods this plugin exposes.
 *   Because `_api` can reference `this['_contract']`, it reactively updates
 *   when `_contract` is overridden.
 *
 * For plugins whose API depends on the contract (like Channels), `_api` reads
 * from `this['_contract']`. For static APIs, `_api` is a fixed shape and
 * `_contract` is ignored — use `StaticApi<{ ... }>` for convenience.
 */
export interface TypeFn {
  /** The input slot — overridden by `Apply` with the real contract. */
  readonly _contract: unknown;
  /** The output slot — computes the plugin's API surface from `_contract`. */
  readonly _api: unknown;
}

/**
 * "Call" a type function: override its `_contract` with `Contract`, read `_api`.
 *
 * How it works: intersect `F` with `{ _contract: Contract }`. In an
 * intersection, when the same property appears in both sides, the more
 * specific type wins for reads — so `_contract` resolves to `Contract`
 * instead of the original `unknown`. Then we index into `_api`, which now
 * computes against the new contract.
 *
 * ```ts
 * type Result = Apply<ChannelsTypeFn, MySocket>;
 * // ChannelsTypeFn's _api evaluates with _contract = MySocket
 * ```
 */
export type Apply<F extends TypeFn, Contract> = (F & {
  readonly _contract: Contract;
})['_api'];

// ---------------------------------------------------------------------------
// Plugin tuple resolution
// ---------------------------------------------------------------------------

/**
 * Walk a tuple of plugins, apply each one's type function with the contract,
 * and intersect all the resulting APIs.
 *
 * Uses tuple recursion: peel the first plugin (`Head`) off the tuple, apply
 * its type function, then recurse on the remaining plugins (`Rest`). Each
 * result is combined with `&` (intersection), so the final type has every
 * plugin's methods merged together. The base case is an empty tuple → `{}`.
 *
 * `[Channels, RequestResponse, Stream]` with contract `T` produces:
 * `Apply<ChannelsTypeFn, T> & Apply<RequestResponseTypeFn, T> & Apply<StreamTypeFn, T>`
 */
export type ApplyPlugins<
  TPlugins extends readonly Plugin<any, any>[],
  TContract,
> = TPlugins extends readonly [
  infer Head extends Plugin<any, any>, // Peel the first plugin
  ...infer Rest extends Plugin<any, any>[], // Collect the rest
]
  ? Apply<Head['_typeFn'], TContract> & ApplyPlugins<Rest, TContract>
  : {}; // Base case: no plugins left, return empty object

/**
 * Validate that each plugin's requirements are satisfied by the contract.
 *
 * Uses the same tuple recursion as `ApplyPlugins`. For each plugin, it checks
 * whether the contract satisfies the plugin's `_requires` constraint. If yes,
 * the plugin passes through unchanged. If not, its slot becomes `never`.
 *
 * The `never` trick: when a caller passes `[PluginA, PluginB]` and the return
 * type expects `[never, PluginB]`, TypeScript can't assign `PluginA` to `never`
 * (nothing is assignable to `never`), so it errors at the call site with a
 * message pointing at the offending plugin. This gives plugin-level validation
 * without extra runtime checks.
 */
export type ValidatePlugins<
  TContract,
  TPlugins extends readonly Plugin<any, any>[],
> = TPlugins extends readonly [
  infer Head extends Plugin<any, any>,
  ...infer Rest extends Plugin<any, any>[],
]
  ? TContract extends Head['_requires'] // Does the contract satisfy this plugin's needs?
    ? [Head, ...ValidatePlugins<TContract, Rest>] // Yes — keep it
    : [never, ...ValidatePlugins<TContract, Rest>] // No — replace with `never` to trigger a type error
  : [];

/**
 * The final socket type: base socket merged with all plugin APIs, simplified
 * for clean editor tooltips.
 */
export type SocketWithPlugins<
  TContract,
  TPlugins extends readonly Plugin<any, any>[],
  TBase,
> = Simplify<TBase & ApplyPlugins<TPlugins, TContract>>;
