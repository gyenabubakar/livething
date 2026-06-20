/**
 * Pass-through for channel handler contexts.
 *
 * The engine builds `ctx.channel` with the family key already under `family`,
 * so no reshaping is needed. Kept as an identity function so call sites stay
 * stable; safe to inline away later.
 */
export function adaptChannelContext(
  ctx: Record<PropertyKey, unknown>,
): Record<PropertyKey, unknown> {
  return ctx;
}
