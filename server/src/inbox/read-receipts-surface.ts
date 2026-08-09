import { listReaders } from '~/inbox/receipts-storage.ts';
import type { EngineAccess } from '~/_engine/access.ts';
import type { ChannelReadReceipts } from '~/context.ts';

/**
 * Build the `ChannelReadReceipts` surface for one concrete channel. Shared by
 * the owning-scope `ctx.channel.readReceipts` member and the handle-augmenter's
 * `handle.readReceipts()`, so both read the same `read_through` cursors keyed on
 * this channel's `(name, family)`.
 */
export function buildReadReceiptsSurface(
  engine: EngineAccess,
  scope: { channelName: string; channelFamily: string | null },
): ChannelReadReceipts {
  const { channelName, channelFamily } = scope;
  return {
    readersOf(seq: number): string[] {
      return listReaders(engine.storage.sql, { channelName, channelFamily, seq });
    },
  };
}
