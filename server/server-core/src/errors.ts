/* oxlint-disable @typescript-eslint/no-explicit-any */
import { error } from '@wskit/core';

// Re-exports from @wskit/core
export { error, WskitError, CloseCodes, Block, Skip, ValidationFailed } from '@wskit/core';
export type { ErrorDef, ErrorDefWithFactory } from '@wskit/core';

// Server-only control flow errors

export function Disconnect(code: number, reason: string) {
  return Object.freeze({ __wskit: 'disconnect' as const, code, reason });
}

export function RejectUpgrade(code: number, reason: string) {
  return Object.freeze({ __wskit: 'reject-upgrade' as const, code, reason });
}

export function Defer(delay: number) {
  return Object.freeze({ __wskit: 'defer' as const, delay });
}

// Server-only built-in error definitions

export const DeferExhausted = error('defer-exhausted', (p: unknown) => {
  const obj = p as Record<string, unknown>;
  return {
    event: String(obj.event),
    payload: obj.payload,
    retries: Number(obj.retries),
  };
});
