/* oxlint-disable @typescript-eslint/no-explicit-any */

/**
 * Expose the channel's family key as `ctx.channel.family`.
 *
 * The engine builds `ctx.channel` with the family key under `scope`; the new
 * authoring API names it `family` (clearer, and consistent with
 * `ctx.channel.name`). This aliases `family` onto the live handle without
 * removing `scope`, so engine internals are untouched. Pure shaping — pulls in
 * no engine code.
 */
export function adaptChannelContext(
  ctx: Record<PropertyKey, unknown>,
): Record<PropertyKey, unknown> {
  const channel = ctx.channel as Record<PropertyKey, unknown> | undefined;
  if (channel && typeof channel === 'object' && !('family' in channel)) {
    channel.family = channel.scope ?? null;
  }
  return ctx;
}
