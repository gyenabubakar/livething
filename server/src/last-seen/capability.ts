import { CAPABILITY_KIND } from '~/_define/capability-kinds.ts';
import { defineHostCapability } from '~/_define/capability.ts';
import { lastSeen as lastSeenFactory } from '~/last-seen/last-seen.ts';
import type { LastSeenOptions } from '~/last-seen/types.ts';

export type { LastSeenOptions, LastSeenTrack } from '~/last-seen/types.ts';

/**
 * Track each connected identity's last-seen timestamp in a durable table, and
 * expose it as `ctx.lastSeen`. By default it stamps on connect and disconnect;
 * `track: 'activity'` also stamps on inbound messages, throttled per identity
 * (default 60s). When listed alongside `inbox()`, the inbox `backlog()` read
 * fills each member's `lastSeenAt` from this table.
 *
 * Requires `persistence()`; the build fails without it.
 *
 * @example
 * ```ts
 * import { define, t } from '@wskit/server';
 * import { persistence } from '@wskit/server/persistence';
 * import { lastSeen } from '@wskit/server/last-seen';
 *
 * const base = define({
 *   env: t<Env>(),
 *   capabilities: [persistence(), lastSeen({ track: 'activity' })],
 * });
 * ```
 */
export const lastSeen = defineHostCapability(
  CAPABILITY_KIND.lastSeen,
  (options?: LastSeenOptions) => lastSeenFactory(options ?? {}),
);
