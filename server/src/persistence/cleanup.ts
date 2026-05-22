import { deleteMembershipsByChannel } from '~/persistence/storage.ts';
import type { SQLProvider } from '~/context.ts';

type RawRow = { channel_name: string; channel_scope: string };

const SELECT_DISTINCT_SCOPES_SQL = `
  SELECT DISTINCT channel_name, channel_scope FROM __wskit_channel_memberships
`;

/**
 * Boot-time reconcile for persistent channels. Walks every `(channel_name,
 * channel_scope)` pair that has at least one durable row, drops the row set
 * for any pair that does not correspond to a still-persistent channel in
 * the freshly-booted server.
 *
 * Returns the number of rows that were dropped. The caller logs one info
 * line so operators know how much dead weight got cleaned up after a
 * schema change.
 *
 * @internal
 */
export function reconcilePersistenceOnBoot(
  sql: Pick<SQLProvider, 'exec'>,
  isPairPersistent: (channelName: string, channelScope: string | null) => boolean,
): number {
  const pairs = sql
    .exec<RawRow>(SELECT_DISTINCT_SCOPES_SQL)
    .toArray()
    .map((row) => ({
      channelName: row.channel_name,
      channelScope: row.channel_scope === '' ? null : row.channel_scope,
    }));

  let dropped = 0;
  for (const pair of pairs) {
    if (isPairPersistent(pair.channelName, pair.channelScope)) continue;
    deleteMembershipsByChannel(sql, pair.channelName, pair.channelScope);
    dropped++;
  }
  return dropped;
}
