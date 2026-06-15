declare const LOCAL_KEY_TYPE: unique symbol;

/**
 * A typed key for `ctx.provide` / `ctx.inject`.
 *
 * The type parameter `T` is phantom — it exists only in TypeScript and is
 * never stored at runtime. Every key carries a unique `Symbol` identity, so two
 * keys are always distinct even with the same (optional) debug name; that
 * identity is what the engine uses for lookup.
 *
 * Create one with `localKey<T>()`.
 */
export interface LocalKey<T> {
  readonly [LOCAL_KEY_TYPE]: T;
  /** Stable unique identity used for `provide` / `inject` lookup. */
  readonly id: symbol;
  /** Optional debug name, surfaced in errors and tooling. */
  readonly name?: string;
}

/**
 * Create a typed lookup key for `ctx.provide` / `ctx.inject`.
 *
 * Each call returns a new, distinct key — identity is an internal `Symbol()`,
 * so two keys never collide even with the same name. Export the key from the
 * module that defines it so both the intercept and the handler can import the
 * same reference. Pass an optional name only for debugging.
 *
 * ```ts
 * export const UserKey = localKey<User>()
 *
 * .intercept(async (ctx, frame) => {
 *   ctx.provide(UserKey, await db.getUser(frame.payload.userId))
 * })
 * .on('message', (ctx, payload) => {
 *   const user = ctx.inject(UserKey) // User | undefined
 * })
 * ```
 */
export function localKey<T>(name?: string): LocalKey<T> {
  return Object.freeze({
    id: Symbol(name),
    ...(name !== undefined ? { name } : {}),
  }) as unknown as LocalKey<T>;
}
