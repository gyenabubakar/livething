import type { Plugin } from '@/plugins/base.ts';
import type { Simplify } from '@/types.ts';

// ---------------------------------------------------------------------------
// HKT — the "type function" pattern
// ---------------------------------------------------------------------------

/**
 * Base interface for plugin type functions. A plugin's type function is an
 * interface with two fields:
 *
 * - `_contract` — the input slot (the socket contract, filled in by `Apply`)
 * - `_api` — the output (the methods this plugin adds, computed from `_contract`)
 *
 * For plugins whose API depends on the contract (like Channels), `_api` reads
 * from `this['_contract']`. For static APIs, `_api` is a fixed shape and
 * `_contract` is ignored — use `StaticApi<{ ... }>` for convenience.
 */
export interface TypeFn {
  readonly _contract: unknown;
  readonly _api: unknown;
}

/**
 * "Call" a type function: override its `_contract` with `Contract`, read `_api`.
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
 * `[Channels, RequestResponse, Stream]` with contract `T` produces:
 * `Apply<ChannelsTypeFn, T> & Apply<RequestResponseTypeFn, T> & Apply<StreamTypeFn, T>`
 */
export type ApplyPlugins<
  TPlugins extends readonly Plugin<any, any>[],
  TContract,
> = TPlugins extends readonly [
  infer Head extends Plugin<any, any>,
  ...infer Rest extends Plugin<any, any>[],
]
  ? Apply<Head['_typeFn'], TContract> & ApplyPlugins<Rest, TContract>
  : {};

/**
 * Validate that each plugin's requirements are satisfied by the contract.
 * If a plugin's `TRequires` is not assignable from `TContract`, its position
 * in the tuple becomes `never`, causing a type error at the call site.
 */
export type ValidatePlugins<
  TContract,
  TPlugins extends readonly Plugin<any, any>[],
> = TPlugins extends readonly [
  infer Head extends Plugin<any, any>,
  ...infer Rest extends Plugin<any, any>[],
]
  ? TContract extends Head['_requires']
    ? [Head, ...ValidatePlugins<TContract, Rest>]
    : [never, ...ValidatePlugins<TContract, Rest>]
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
