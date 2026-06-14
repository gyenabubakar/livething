/* oxlint-disable @typescript-eslint/no-explicit-any */

/**
 * Present the engine's stream context as one unified `ctx.stream` handle.
 *
 * The engine installs `ctx.nudges` on every stream context and, for durable
 * streams, a separate `ctx.stream` with `cursor` / `attempt` / `withCursor`.
 * Generators in the new authoring API read everything from a single
 * `ctx.stream` handle, so this merges `nudges` into that handle (creating it for
 * plain streams that have no durable `ctx.stream`). It is a pure shaping step —
 * it pulls in no engine code.
 */
export function adaptStreamContext(
  ctx: Record<PropertyKey, unknown>,
): Record<PropertyKey, unknown> {
  const nudges = ctx.nudges;
  const existing = ctx.stream;
  if (existing && typeof existing === 'object') {
    (existing as Record<PropertyKey, unknown>).nudges = nudges;
  } else {
    ctx.stream = { nudges };
  }
  return ctx;
}
