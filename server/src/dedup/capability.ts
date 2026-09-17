import { CAPABILITY_KIND } from '~/_define/capability-kinds.ts';
import { defineHostCapability } from '~/_define/capability.ts';
import { dedup as dedupFactory } from '~/dedup/dedup.ts';

type OptionsParameter = { cap?: number };

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
 * import { server, t } from '@wskit/server';
 * import { dedup } from '@wskit/server/dedup';
 *
 * const base = server({ capabilities: [dedup({ cap: 256 })] });
 * ```
 */
export const dedup = defineHostCapability(CAPABILITY_KIND.dedup, (options?: OptionsParameter) =>
  dedupFactory(options),
);
