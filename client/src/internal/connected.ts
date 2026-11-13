import type { ConnectedInfo } from '~/internal/runtime.ts';

function isNumberOrNull(value: unknown): value is number | null {
  return value === null || typeof value === 'number';
}

/** The values of a `__connected__` frame, or `null` when the payload is not one. */
export function parseConnectedInfo(payload: unknown): ConnectedInfo | null {
  if (typeof payload !== 'object' || payload === null) return null;

  const { pingIntervalMs, idleTimeoutMs, maxResumeTokens, connectionId, features, resume } =
    payload as Record<string, unknown>;
  const resumeIsValid =
    resume === null ||
    (typeof resume === 'object' &&
      typeof (resume as { token?: unknown }).token === 'string' &&
      isNumberOrNull((resume as { seq?: unknown }).seq));
  const isValid =
    isNumberOrNull(pingIntervalMs) &&
    isNumberOrNull(idleTimeoutMs) &&
    typeof maxResumeTokens === 'number' &&
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
