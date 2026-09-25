import type { InterceptFn } from '~/internal/runtime.ts';
import type { EmptyTypeFn, Primitive } from '~/primitives/types.ts';

export type { InterceptFn };

/**
 * Looks at every incoming app message before it is delivered: before your
 * `on()` handlers, channel listeners, and stream loops. Return nothing to leave
 * it alone, return a new message to change it, or throw `Block` to drop it. You
 * can add `intercept()` more than once; they run in the order you list them and
 * stop at the first `Block`.
 *
 * Only `dedup()` runs earlier, so a duplicate never reaches here. Protocol
 * frames (`__…__`), request replies and server-to-client requests, and a
 * plugin's own namespaced traffic skip intercepts.
 *
 * ```ts
 * intercept((message) => {
 *   if (message.event === 'heartbeat') throw Block;
 * });
 * ```
 */
export function intercept(interceptor: InterceptFn): Primitive<EmptyTypeFn> {
  return {
    _tag: 'intercept',
    applyConfig(config) {
      (config.intercepts ??= []).push(interceptor);
    },
  };
}

intercept.tag = 'intercept';
