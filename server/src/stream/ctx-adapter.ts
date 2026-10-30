/* oxlint-disable @typescript-eslint/no-explicit-any */

/**
 * Present the engine's stream context as one unified `ctx.stream` handle.
 *
 * The engine installs `ctx.nudges`, the stop `signal`, and the backpressure
 * `drain` on every stream context. Generators read them from a single
 * `ctx.stream` handle, so this gathers them there. It is a pure shaping step —
 * it pulls in no engine code.
 */
export function adaptStreamContext(
  ctx: Record<PropertyKey, unknown>,
): Record<PropertyKey, unknown> {
  ctx.stream = { nudges: ctx.nudges, signal: ctx.signal, drain: ctx.drain };
  return ctx;
}
