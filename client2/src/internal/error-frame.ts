import { WSKitError } from '@wskit/core';

/** Turn an `__error__` frame's `{ code, detail? }` payload into a `WSKitError`. */
export function toWSKitError(payload: unknown): WSKitError {
  const p = (payload ?? {}) as { code?: unknown; detail?: unknown };
  const code = typeof p.code === 'string' ? p.code : 'internal-error';
  return new WSKitError(code, p.detail);
}
