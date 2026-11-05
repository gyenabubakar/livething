import { serializePayload } from '~/_engine/runtime/json-guard.ts';
import { serializeWireFrame } from '~/_engine/runtime/wire-serialize.ts';
import { loadInboxBacklog } from '~/inbox/backlog.ts';
import { listReceivers } from '~/inbox/receipts-storage.ts';
import { backfillInbox, channelKeyFor, inboxRowTooBig } from '~/inbox/runtime.ts';
import { loadInboxWatermarks } from '~/inbox/storage.ts';
import { binaryPayload } from '~/outgoing/binary-payload.ts';
import { assertEnvelopeSize } from '~/outgoing/runtime.ts';
import type { EngineAccess } from '~/_engine/access.ts';
import type {
  ChannelBackfillMessage,
  ChannelBinaryBackfillMessage,
  ChannelInbox,
  InboxBacklogEntry,
} from '~/context.ts';
import type { InboxFrame } from '~/inbox/storage.ts';

interface InboxScope {
  channelName: string;
  channelFamily: string | null;
}

/** One message `backfill` or `binary.backfill` was given, before it gets its seq. */
interface BackfillInput {
  event: string;
  payload: unknown;
  bytes?: Uint8Array;
  messageId: string;
}

/**
 * Build the `ChannelInbox` surface for one concrete channel. Shared by the
 * owning-scope `ctx.channel.inbox` member and the handle-augmenter's
 * `handle.inbox()`, so both expose the same backfill / receiversOf / backlog
 * behaviour keyed on this channel's `(name, family)`.
 */
export function buildInboxSurface<
  TOutgoing extends Record<string, unknown> = Record<string, unknown>,
>(engine: EngineAccess, scope: InboxScope): ChannelInbox<TOutgoing> {
  const { channelName, channelFamily } = scope;

  function backfill(userId: string, messages: readonly BackfillInput[]): void {
    if (engine.isUserPurging?.(userId)) return;

    const config = engine.getInboxChannel(channelKeyFor(channelName, channelFamily));
    const limits = {
      maxValueBytes: engine.storage.sql.limits.maxValueBytes,
      sendBytes: engine.getMessageLimits().sendBytes,
      maxBytes: config?.retention?.maxBytes,
    };

    // The same rule as every payload that is sent: an object or null in JSON, stored as that JSON.
    const checked = messages.map((message) => ({
      ...message,
      payload: JSON.parse(serializePayload(message.event, message.payload)) as Record<
        string,
        unknown
      > | null,
    }));
    // Nothing is stored when one message cannot be: the call throws, as a send over a limit does.
    for (const message of checked) {
      const tooBig = inboxRowTooBig({ channelName, channelFamily, ...message }, limits);
      if (tooBig) throw new RangeError(`[livething] inbox backfill of ${tooBig.reason}.`);

      // A binary row whose info and metadata are over 64 KiB could never be sent. The seq is
      // not known yet, so the check counts the biggest one.
      if (message.bytes !== undefined) {
        assertEnvelopeSize(
          serializeWireFrame(message.event, message.payload, {
            deliverySeq: Number.MAX_SAFE_INTEGER,
            messageId: message.messageId,
            channel: channelName,
            ...(channelFamily === null ? {} : { channelFamily }),
          }),
        );
      }
    }

    // Seqs come from the counter live sends use, so a backfilled row never
    // takes a seq a later live message needs. A failed write leaves a gap,
    // which is harmless.
    const frames: InboxFrame[] = checked.map((message) => ({
      deliverySeq: engine.allocateDeliverySeq(),
      messageId: message.messageId,
      event: message.event,
      payload: message.payload,
      ...(message.bytes === undefined ? {} : { bytes: message.bytes }),
    }));
    const stored = backfillInbox(engine.storage.sql, {
      channelName,
      channelFamily,
      userId,
      frames,
      retention: config?.retention,
    });
    if (config?.retention?.maxAgeMs !== undefined) engine.rescheduleAlarm?.();
    // These rows bypassed the live fan-out that keeps the count cache warm, so
    // the cached value is now too low. Drop it and let the next write re-read.
    engine.invalidateInboxMemberCount?.(channelName, channelFamily, userId);

    // A member in the channel right now gets the new rows straight away, the
    // same frames the reconnect drain sends. Otherwise its ack of a later live
    // message would settle these rows before it ever saw them, and clear the
    // watermark of any row retention dropped, so the gap goes first.
    const connectionIds = engine.userConnectionIdsInChannel(userId, channelName, channelFamily);
    if (connectionIds.length === 0) return;

    const watermark = loadInboxWatermarks(engine.storage.sql, userId).find(
      (row) => row.channelName === channelName && row.channelFamily === channelFamily,
    );

    for (const connectionId of connectionIds) {
      if (watermark) {
        engine.sendGap(connectionId, {
          channelName,
          channelFamily,
          missedThrough: watermark.evictedThroughSeq,
        });
      }

      for (const frame of stored) {
        engine.sendReplay(connectionId, {
          channelName,
          channelFamily,
          event: frame.event,
          payload: frame.payload,
          bytes: frame.bytes,
          wire: {
            deliverySeq: frame.deliverySeq,
            messageId: frame.messageId,
            channel: channelName,
          },
          // A drain that is still sending older rows holds it, so the member's ack of this
          // row cannot settle older rows it has not got yet.
          live: true,
        });
      }
    }
  }

  return {
    backfill(userId: string, messages: readonly ChannelBackfillMessage<TOutgoing>[]): void {
      backfill(
        userId,
        messages.map((message) => ({
          event: message.event,
          payload: message.payload,
          messageId: message.__livething.messageId,
        })),
      );
    },
    binary: {
      backfill(userId: string, messages: readonly ChannelBinaryBackfillMessage[]): void {
        backfill(
          userId,
          messages.map((message) => {
            const { info, bytes } = binaryPayload(message.info, message.bytes);
            return {
              event: message.event,
              payload: info,
              bytes,
              messageId: message.__livething.messageId,
            };
          }),
        );
      },
    } as ChannelInbox<TOutgoing>['binary'],
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
