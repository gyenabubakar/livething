// ---------------------------------------------------------------------------
// HKT — the "type function" pattern
// ---------------------------------------------------------------------------
//
// TypeScript doesn't support higher-kinded types natively (a type that takes
// another type as a parameter and returns a new type). This is the workaround
// used by both the client plugin system and the server primitive/module system.

/**
 * Base interface for type functions. Think of it as a function that operates
 * on types instead of values:
 *
 * - `_contract` — the "parameter" slot. Holds `unknown` by default, but
 *   `Apply` overrides it with the actual contract via intersection.
 * - `_api` — the "return value". Computes the API surface from `_contract`.
 *   Because `_api` can reference `this['_contract']`, it reactively updates
 *   when `_contract` is overridden.
 *
 * ```ts
 * interface MyTypeFn extends TypeFn {
 *   readonly _api: this['_contract'] extends { outgoing: infer O }
 *     ? { broadcast<K extends keyof O>(event: K, payload: O[K]): void }
 *     : {};
 * }
 * ```
 */
export interface TypeFn {
  /** The input slot — overridden by `Apply` with the real contract. */
  readonly _contract: unknown;
  /** The output slot — computes the API surface from `_contract`. */
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
