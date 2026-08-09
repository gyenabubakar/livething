import { deleteMembershipsByChannel } from '~/channel/storage.ts';
import type { SQLProvider } from '~/context.ts';

type RawRow = { channel_name: string; channel_family: string };

/**
 * Boot-time reconcile for persistent channels. Walks every `(channel_name,
 * channel_family)` pair that has at least one durable row, drops the row set
 * for any pair that does not correspond to a still-persistent channel in
 * the freshly-booted server.
 *
 * Returns the number of rows that were dropped. The caller logs one info
 * line so operators know how much dead weight got cleaned up after a
 * schema change.
 *
 * @internal
 */
export function reconcileMembershipOnBoot(
  sql: Pick<SQLProvider, 'exec'>,
  isPairPersistent: (channelName: string, channelFamily: string | null) => boolean,
): number {
  const pairs = sql
    .exec<RawRow>('SELECT DISTINCT channel_name, channel_family FROM __wskit_channel_memberships')
    .toArray()
    .map((row) => ({
      channelName: row.channel_name,
      channelFamily: row.channel_family === '' ? null : row.channel_family,
    }));

  let dropped = 0;
  for (const pair of pairs) {
    if (isPairPersistent(pair.channelName, pair.channelFamily)) continue;
    deleteMembershipsByChannel(sql, pair.channelName, pair.channelFamily);
    dropped++;
  }
  return dropped;
}
