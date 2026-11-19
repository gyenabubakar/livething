import { LiveThingConfigError } from '@livething/core';
import type { StandardSchemaV1 } from '@standard-schema/spec';

/** Whether `value` is a Standard Schema with a `validate` function. */
export function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  return (
    !!value &&
    typeof value === 'object' &&
    '~standard' in value &&
    typeof (value as { '~standard'?: { validate?: unknown } })['~standard']?.validate === 'function'
  );
}

const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

/**
 * The last time a Cloudflare Durable Object alarm takes, 2262-04-11T23:47:16.854Z,
 * found by running workerd. One millisecond later `setAlarm` throws, with a message
 * that says 2189.
 */
const MAX_ALARM_TIME_MS = 9_223_372_036_854;

/** 100 years. A run this far after any time before the year 2162 still fits an alarm. */
const MAX_ALARM_DELAY_MS = 3_155_760_000_000;

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
 * A positive integer that a timer can hold. `setTimeout` and `setInterval` treat
 * anything above `2 ** 31 - 1` ms as 1 ms, so such a value would fire constantly.
 */
export function assertTimerDelay(value: unknown, field: string, context: string): void {
  assertPositiveInteger(value, field, context);
  if ((value as number) > MAX_TIMER_DELAY_MS) {
    throw new LiveThingConfigError(
      `${context}: '${field}' must be at most ${MAX_TIMER_DELAY_MS} ms, the longest a timer can hold, got ${String(value)}.`,
    );
  }
}

/**
 * A positive integer time, in Unix milliseconds, that every platform's alarm can
 * hold. Past the limit, the alarm write would fail after the run was stored.
 */
export function assertAlarmTime(value: unknown, field: string, context: string): void {
  assertPositiveInteger(value, field, context);
  if ((value as number) > MAX_ALARM_TIME_MS) {
    throw new LiveThingConfigError(
      `${context}: '${field}' must be at most ${MAX_ALARM_TIME_MS} (April 2262), the latest time an alarm can hold, got ${String(value)}.`,
    );
  }
}

/**
 * A positive integer delay in milliseconds. The limit is fixed, not "the last alarm
 * time minus now", because a delay is added to the time of each later run.
 */
export function assertAlarmDelay(value: unknown, field: string, context: string): void {
  assertPositiveInteger(value, field, context);
  if ((value as number) > MAX_ALARM_DELAY_MS) {
    throw new LiveThingConfigError(
      `${context}: '${field}' must be at most ${MAX_ALARM_DELAY_MS} ms (100 years), got ${String(value)}.`,
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
