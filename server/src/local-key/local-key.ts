declare const LOCAL_KEY_TYPE: unique symbol;

/**
 * A typed key for `ctx.provide` / `ctx.inject`.
 *
 * The type parameter `T` is phantom — it exists only in TypeScript and is
 * never stored at runtime. Two keys created with the same name are always
 * distinct; identity (object reference) is what the engine uses for lookup.
 *
 * Create one with `localKey<T>(name)`.
 */
export interface LocalKey<T> {
  readonly [LOCAL_KEY_TYPE]: T;
  readonly name: string;
}

/**
 * Create a typed lookup key for `ctx.provide` / `ctx.inject`.
 *
 * Each call returns a new, distinct key — even when the same name is used
 * twice. Export the key from the module that defines it so both the intercept
 * and the handler can import the same reference.
 *
 * ```ts
 * export const UserKey = localKey<User>('user')
 *
 * .intercept(async (ctx, frame) => {
 *   ctx.provide(UserKey, await db.getUser(frame.payload.userId))
 * })
 * .on('message', (ctx, payload) => {
 *   const user = ctx.inject(UserKey) // User | undefined
 * })
 * ```
 */
export function localKey<T>(name: string): LocalKey<T> {
  return Object.freeze({ name }) as unknown as LocalKey<T>;
}
