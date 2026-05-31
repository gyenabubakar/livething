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
 * so the message points the developer at the right place.
 */
export function assertValidWSKitIdentifier(name: unknown, kind: string): asserts name is string {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error(`[wskit] ${kind} must be a non-empty string.`);
  }
  if (name.startsWith('__')) {
    throw new Error(
      `[wskit] ${kind} '${name}' starts with the reserved '__' prefix. ` +
        `That prefix is reserved for wskit protocol and plugin identifiers — pick a different name.`,
    );
  }
}
