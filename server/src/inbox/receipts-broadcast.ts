import type { EngineAccess } from '~/_engine/access.ts';

/**
 * Broadcast one receipt fan-out frame to the channel's live members, but only
 * while the member count is within `maxReceiptAudience`. Above the threshold the
 * cursor is still stored and stays queryable via `receiversOf` / `readersOf`.
 *
 * Shared by `inbox()` (the `__received__` fan-out) and `readReceipts()` (the
 * `__read__` fan-out) so neither capability imports the other — each owns its
 * own event name and payload and calls this with them.
 */
export function broadcastReceipt(
  engine: EngineAccess,
  maxReceiptAudience: number,
  opts: {
    channelName: string;
    channelFamily: string | null;
    event: '__received__' | '__read__';
    payload: Record<string, unknown>;
  },
): void {
  if (engine.channelMemberCount(opts.channelName, opts.channelFamily) > maxReceiptAudience) return;

  engine.broadcastToChannel({
    channelName: opts.channelName,
    channelFamily: opts.channelFamily,
    event: opts.event,
    payload: opts.payload,
  });
}
