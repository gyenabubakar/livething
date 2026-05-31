import type { InterceptFn } from '~/internal/runtime.ts';
import type { EmptyTypeFn, PrimitiveSpec } from '~/primitives/types.ts';

export type { InterceptFn };

/**
 * Filter or transform every incoming message before it reaches `.on()` handlers.
 * Return nothing to pass through, return a modified message to transform, or
 * throw `Block` to drop it. Multiple `intercept()` calls run in declaration
 * order; the first to throw `Block` stops the chain.
 *
 * Unlike server-side intercepts, client intercepts receive no context object —
 * read socket state via `getState()`, `getQuality()`, etc.
 *
 * ```ts
 * intercept((message) => {
 *   if (message.event === 'heartbeat') throw Block;
 * });
 * ```
 */
export function intercept(fn: InterceptFn): PrimitiveSpec<EmptyTypeFn> {
  return {
    _tag: 'intercept',
    applyConfig(config) {
      (config.intercepts ??= []).push(fn);
    },
  };
}
