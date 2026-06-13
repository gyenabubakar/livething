import { WSKitError } from '@wskit/core';

/** Turn an `__error__` frame's `{ code, detail? }` payload into a `WSKitError`. */
export function toWSKitError(payload: unknown): WSKitError {
  const fields = (payload ?? {}) as { code?: unknown; detail?: unknown };
  const code = typeof fields.code === 'string' ? fields.code : 'internal-error';
  return new WSKitError(code, fields.detail);
}
