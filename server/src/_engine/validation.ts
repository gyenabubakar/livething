import { LiveThingConfigError } from '@livething/core';

interface AllowedValueLocation {
  field: string;
  context: string;
}

/**
 * Reject numeric config that would silently break runtime math or unbound a
 * cap. `windowMs: 0` divides by zero in rate-limit refill; `maxChunks: 0`
 * makes a `if (def.maxChunks)` truthy gate skip the cap entirely; `maxAgeMs:
 * Infinity` makes a `now - maxAgeMs` produce `-Infinity` and prunes nothing. The accepted
 * shape is a positive integer that fits in `Number.MAX_SAFE_INTEGER`.
 *
 * Throws `LiveThingConfigError` so build paths fail fast — the engine refuses to
 * construct and the server doesn't start.
 */
export function assertPositiveInteger(value: unknown, field: string, context: string): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new LiveThingConfigError(
      `${context}: '${field}' must be a positive safe integer, got ${typeof value === 'number' ? value : typeof value}.`,
    );
  }
}

/**
 * Same shape as `assertPositiveInteger` but skips when `value` is undefined.
 * Use for optional config fields where "not set" is a real, separate state
 * from "set to a bad value."
 */
export function assertOptionalPositiveInteger(
  value: unknown,
  field: string,
  context: string,
): void {
  if (value === undefined) return;

  assertPositiveInteger(value, field, context);
}

/**
 * Reject string-enum config that was widened to `string` (usually via
 * `as any`). The runtime then silently picks the `else` branch instead of
 * the expected behavior. Throws `LiveThingConfigError` so the misconfiguration
 * fails at build time with the allowed set spelled out.
 */
export function assertOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  where: AllowedValueLocation,
): asserts value is T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new LiveThingConfigError(
      `${where.context}: '${where.field}' must be one of ${allowed.map((v) => `'${v}'`).join(', ')}, got ${JSON.stringify(value)}.`,
    );
  }
}
