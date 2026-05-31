// ---------------------------------------------------------------------------
// HKT — the "type function" pattern
// ---------------------------------------------------------------------------
//
// TypeScript doesn't support higher-kinded types natively (a type that takes
// another type as a parameter and returns a new type). This is the workaround
// used by both the client plugin system and the server primitive/module system.

/**
 * Base interface for declaring a type function — a type that computes an API
 * surface from a contract type. Extend this when you're building a typed
 * primitive or plugin that adds methods to a socket/server.
 *
 * Set `_api` to a conditional type that reads from `this['_contract']`, then
 * resolve the final API with {@link Apply}.
 *
 * ```ts
 * interface MyTypeFn extends TypeFn {
 *   readonly _api: this['_contract'] extends { outgoing: infer O }
 *     ? { broadcast<K extends keyof O>(event: K, payload: O[K]): void }
 *     : {};
 * }
 *
 * type MyAPI = Apply<MyTypeFn, MySocket>;
 * ```
 */
export interface TypeFn {
  /** The contract type this function operates on. {@link Apply} supplies it — do not assign directly. */
  readonly _contract: unknown;
  /** Declare your computed API surface here, reading from `this['_contract']`. */
  readonly _api: unknown;
}

/**
 * Resolve a type function against a concrete contract, producing the API
 * surface declared by `F._api`.
 *
 * ```ts
 * type Result = Apply<ChannelsTypeFn, MySocket>;
 * // The API that ChannelsTypeFn produces for MySocket.
 * ```
 */
export type Apply<F extends TypeFn, Contract> = (F & {
  readonly _contract: Contract;
})['_api'];
