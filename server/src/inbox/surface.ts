import { loadInboxBacklog } from '~/inbox/backlog.ts';
import { listReceivers } from '~/inbox/receipts-storage.ts';
import { backfillInbox, channelKeyFor } from '~/inbox/runtime.ts';
import type { EngineAccess } from '~/_engine/access.ts';
import type { ChannelInbox, InboxBacklogEntry } from '~/context.ts';
import type { BackfillMessage, InboxFrame } from '~/inbox/storage.ts';

/**
 * Build the `ChannelInbox` surface for one concrete channel. Shared by the
 * owning-scope `ctx.channel.inbox` member and the handle-augmenter's
 * `handle.inbox()`, so both expose the same backfill / receiversOf / backlog
 * behaviour keyed on this channel's `(name, family)`.
 */
export function buildInboxSurface(
  engine: EngineAccess,
  scope: { channelName: string; channelFamily: string | null },
): ChannelInbox {
  const { channelName, channelFamily } = scope;
  return {
    backfill(userId: string, messages: readonly BackfillMessage[]): void {
      const frames: InboxFrame[] = messages.map((message) => ({
        seq: message.__wskit.seq,
        messageId: message.__wskit.messageId,
        event: message.event,
        payload: assertRecord(message.payload),
      }));
      const config = engine.getInboxChannel(channelKeyFor(channelName, channelFamily));
      backfillInbox(engine.storage.sql, {
        channelName,
        channelFamily,
        userId,
        frames,
        retention: config?.retention,
      });
      // These rows bypassed the live fan-out that keeps the count cache warm, so
      // the cached value is now too low. Drop it and let the next write re-read.
      engine.invalidateInboxMemberCount?.(channelName, channelFamily, userId);
    },
    receiversOf(seq: number): string[] {
      return listReceivers(engine.storage.sql, { channelName, channelFamily, seq });
    },
    backlog(): InboxBacklogEntry[] {
      const { sql } = engine.storage;
      const lastSeen = engine.getLastSeenService();
      return loadInboxBacklog(sql, { channelName, channelFamily }).map((row) => {
        const base = {
          userId: row.userId,
          online: engine.isUserOnline(row.userId),
          heldRows: row.heldRows,
          receivedThrough: row.receivedThrough,
          oldestHeldAt: row.oldestHeldAt,
        };
        const entry: InboxBacklogEntry = lastSeen
          ? { ...base, lastSeenAt: lastSeen.at(row.userId) }
          : base;
        return entry;
      });
    },
  };
}

function assertRecord(value: Record<string, unknown>): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('[wskit] inbox backfill payload must be a plain object.');
  }
  return value;
}
