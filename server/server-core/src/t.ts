/* oxlint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// t<T>() — zero-cost type carrier
// ---------------------------------------------------------------------------

/**
 * Phantom type that carries a generic. Has no runtime value — exists only
 * so TypeScript can read the type parameter `T` from the position where
 * it's used.
 *
 * You'll never interact with `TypeMarker` directly. It's the return type
 * of `t<T>()`, and primitives like `outgoing` and `chunks` read `T` from it.
 */
export interface TypeMarker<out T> {
  /** Phantom brand — never assigned, only used by the type system. */
  readonly __type: T;
}

/**
 * Type-only helper for declaring data shapes. Does nothing at runtime —
 * the implementation literally returns `undefined`. Its only job is to
 * carry the generic `T` so the event name can come first in the argument list.
 *
 * Used by `outgoing`, `generate`, and `scheduled` to declare what shape
 * the data has without providing a runtime value.
 *
 * ```ts
 * outgoing('message', t<{ text: string; from: string }>())
 *
 * stream(
 *   stream.event('ask-ai', AskAIValidator),
 *   generate(async function* (ctx, payload) { ... }, {
 *     chunks: t<{ text: string }>(),
 *   }),
 * )
 * ```
 */
export function t<T>(): TypeMarker<T> {
  return undefined as any;
}
