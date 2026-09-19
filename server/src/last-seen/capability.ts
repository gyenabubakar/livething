import { CAPABILITY_KIND } from '~/_define/capability-kinds.ts';
import { defineHostCapability } from '~/_define/capability.ts';
import { lastSeen as lastSeenFactory } from '~/last-seen/last-seen.ts';
import type { LastSeenOptions } from '~/last-seen/types.ts';

export type { LastSeenOptions, LastSeenTrack } from '~/last-seen/types.ts';

/**
 * Track each connected user's last-seen timestamp in a durable table, and
 * expose it as `ctx.lastSeen`. By default it stamps on connect and disconnect;
 * `track: 'activity'` also stamps on inbound messages, throttled per user
 * (default 60s). When listed alongside `inbox()`, the inbox `backlog()` read
 * fills each member's `lastSeenAt` from this table.
 *
 * @example
 * ```ts
 * import { server, t } from '@livething/server';
 * import { lastSeen } from '@livething/server/last-seen';
 *
 * const base = server({
 *   capabilities: [lastSeen({ track: 'activity' })],
 * });
 * ```
 */
export const lastSeen = defineHostCapability(
  CAPABILITY_KIND.lastSeen,
  (options?: LastSeenOptions) => lastSeenFactory(options ?? {}),
);
