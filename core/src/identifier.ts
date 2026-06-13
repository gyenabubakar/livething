/**
 * The wire-protocol length limit for each kind of identifier. One source of
 * truth for server protocol validation, server declaration checks, and the
 * client's before-send checks, so the three can't drift.
 */
export const WIRE_LIMITS = Object.freeze({
  event: 128,
  channel: 256,
  channelScope: 128,
  streamId: 128,
  wireId: 128,
});

/** True when `value` is a string longer than `limit` characters. */
export function exceedsWireLimit(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length > limit;
}

/**
 * One rule for every identifier a developer chooses: event names, error codes,
 * channel names, namespace names, and tag group names.
 *
 * The `__` prefix is reserved for the engine — protocol frames are named
 * `__x__` and plugin-owned events/errors are namespaced as `__pluginId:...`.
 * So a user-chosen identifier may not start with `__`, and must be a non-empty
 * string. Keeping this in one place means the same rule is enforced everywhere
 * instead of each call site inventing its own check.
 */
export function isValidWSKitIdentifier(name: unknown): name is string {
  return typeof name === 'string' && name.length > 0 && !name.startsWith('__');
}

/**
 * Throw a clear build-time error when `name` is not a valid WSKit identifier.
 * `kind` names the thing being checked, e.g. `"event name"` or `"error code"`,
 * so the message points the developer at the right place. Pass `maxLength`
 * (from {@link WIRE_LIMITS}) to also reject names too long for the wire.
 */
export function assertValidWSKitIdentifier(
  name: unknown,
  kind: string,
  maxLength?: number,
): asserts name is string {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error(`[wskit] ${kind} must be a non-empty string.`);
  }
  if (name.startsWith('__')) {
    throw new Error(
      `[wskit] ${kind} '${name}' starts with the reserved '__' prefix. ` +
        `That prefix is reserved for wskit protocol and plugin identifiers — pick a different name.`,
    );
  }
  if (maxLength !== undefined && name.length > maxLength) {
    throw new Error(
      `[wskit] ${kind} is ${name.length} characters; the wire protocol limit is ${maxLength}. ` +
        `A longer name can't travel over the wire, so the client could never reach it.`,
    );
  }
}
