import type { ConnectedInfo } from '~/internal/runtime.ts';

/** The wire protocol's bounds: a whole number from 0 to `Number.MAX_SAFE_INTEGER`. */
function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isCountOrNull(value: unknown): value is number | null {
  return value === null || isCount(value);
}

function isResumeToken(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 64;
}

/** The values of a `__connected__` frame, or `null` when the payload is not one. */
export function parseConnectedInfo(payload: unknown): ConnectedInfo | null {
  if (typeof payload !== 'object' || payload === null) return null;

  const { pingIntervalMs, idleTimeoutMs, maxResumeTokens, connectionId, features, resume } =
    payload as Record<string, unknown>;
  const resumeIsValid =
    resume === null ||
    (typeof resume === 'object' &&
      isResumeToken((resume as { token?: unknown }).token) &&
      isCountOrNull((resume as { seq?: unknown }).seq));
  const isValid =
    isCountOrNull(pingIntervalMs) &&
    isCountOrNull(idleTimeoutMs) &&
    isCount(maxResumeTokens) &&
    typeof connectionId === 'string' &&
    Array.isArray(features) &&
    features.every((feature) => typeof feature === 'string') &&
    resumeIsValid;
  if (!isValid) return null;

  return {
    pingIntervalMs,
    idleTimeoutMs,
    maxResumeTokens,
    connectionId,
    features,
    resume: resume as ConnectedInfo['resume'],
  };
}
