/* oxlint-disable @typescript-eslint/no-explicit-any */

/**
 * Present the engine's stream context as one unified `ctx.stream` handle.
 *
 * The engine installs `ctx.nudges` on every stream context and, for durable
 * streams, a separate `ctx.stream` with `cursor` / `attempt` / `withCursor`.
 * Generators in the new authoring API read everything from a single
 * `ctx.stream` handle, so this merges `nudges`, the stop `signal`, and the
 * backpressure `drain` into that handle (creating it for plain streams that
 * have no durable `ctx.stream`). It is a pure shaping step — it pulls in no
 * engine code.
 */
export function adaptStreamContext(
  ctx: Record<PropertyKey, unknown>,
): Record<PropertyKey, unknown> {
  const nudges = ctx.nudges;
  const signal = ctx.signal;
  const drain = ctx.drain;
  const existing = ctx.stream;
  if (existing && typeof existing === 'object') {
    (existing as Record<PropertyKey, unknown>).nudges = nudges;
    (existing as Record<PropertyKey, unknown>).signal = signal;
    (existing as Record<PropertyKey, unknown>).drain = drain;
  } else {
    ctx.stream = { nudges, signal, drain };
  }
  return ctx;
}
