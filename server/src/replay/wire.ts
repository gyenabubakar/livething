/**
 * Wire metadata for one replay frame.
 *
 * `deliverySeq`  — monotonically increasing per-connection sequence number.
 * `messageId`    — unique id for dedup on the client.
 * `channel`      — concrete channel name when the replay is pinned to a channel
 *                  (omit for true top-level replays).
 * `channelFamily` — family key for dynamic channels, `null` for static channels,
 *                  omit/`null` for true top-level replays. Pass this back
 *                  alongside `channel` so client-side family routing keeps
 *                  working on the resent frame.
 */
export interface ReplayWire {
  readonly deliverySeq: number;
  readonly messageId: string;
  readonly channel?: string;
  readonly channelFamily?: string | null;
}
