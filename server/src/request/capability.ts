import { capability } from '~/_define/capability.ts';
import type { Capability } from '~/_define/capability.ts';

/**
 * Enable client→server requests. Listing this lets you register `base.request`
 * handlers — a request is like `base.on`, but the client awaits a reply and the
 * reply type is inferred from what the handler returns.
 *
 * @example
 * ```ts
 * import { define, requests, t } from '@wskit/server';
 * import * as v from 'valibot';
 *
 * const base = define({ env: t<Env>(), capabilities: [requests()] });
 *
 * export const handleGetTime = base.request('get-time', {
 *   input: v.object({}),
 *   run() {
 *     return { now: new Date().toISOString() };
 *   },
 * });
 * ```
 */
export function requests(): Capability<{}, never, 'requests'> {
  return capability<{}, never, 'requests'>([]);
}
