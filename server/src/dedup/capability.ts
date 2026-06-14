import { capability } from '~/_define/capability.ts';
import { dedup as dedupFactory } from '~/dedup/dedup.ts';
import type { Capability } from '~/_define/capability.ts';

/**
 * Drop duplicate incoming messages. The engine remembers the most recent
 * message ids per connection and silently ignores any frame whose id it has
 * already seen — protecting handlers from client retries over a flaky network.
 *
 * @param options.cap How many recent message ids to remember per connection.
 *   Defaults to 256.
 *
 * @example
 * ```ts
 * import { define, t } from '@wskit/server';
 * import { dedup } from '@wskit/server/dedup';
 *
 * const base = define({ env: t<Env>(), capabilities: [dedup({ cap: 256 })] });
 * ```
 */
export function dedup(options?: { cap?: number }): Capability<{}, 'dedup'> {
  return capability<{}, 'dedup'>([dedupFactory(options)], ['dedup']);
}
