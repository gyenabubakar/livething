import { sendReplay } from '~/_engine/runtime/wire.ts';
import {
  ackInboxRows,
  bumpInboxWatermark,
  deleteInboxRowsForChannel,
  insertInboxRows,
  insertInboxRowsForIdentity,
  loadUndeliveredRows,
  pruneInboxRetention,
} from '~/inbox/storage.ts';
import { listIdentitiesByChannel } from '~/persistence/storage.ts';
import { createPersistentSequenceAllocator } from '~/sequence/runtime.ts';
import type { EngineCore } from '~/_engine/core.ts';
import type { ResolvedInboxOptions } from '~/_engine/runtime/feature-slots.ts';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';
import type { SQLProvider } from '~/context.ts';
import type { InboxFrame } from '~/inbox/storage.ts';

/**
 * A message id generator paired with the shared persistent sequence allocator.
 * One allocator per engine keeps inbox message ids monotonic and durable, drawn
 * from the same global counter the wire uses so client dedup and ordering line
 * up. Held in a WeakMap so multiple engines never share one counter.
 */
const allocators = new WeakMap<EngineCore, { next(): number }>();

function inboxAllocator(core: EngineCore): { next(): number } {
  let allocator = allocators.get(core);
  if (!allocator) {
    allocator = createPersistentSequenceAllocator(core.requireStorage().sql);
    allocators.set(core, allocator);
  }
  return allocator;
}

/** Resolve the channel key (family key for families, name for static channels). */
function channelKeyFor(channelName: string, channelFamily: string | null): string {
  return channelFamily ?? channelName;
}

/**
 * Fan one logical channel message out to every durable member's inbox. Runs once
 * per broadcast and returns the single `seq`/`messageId` it stamped — the caller
 * pins the live broadcast to the same identity so a member's live frame matches
 * its durable inbox row (its ack settles the row, and dedup suppresses the
 * reconnect re-delivery). Returns `undefined` for a channel without inbox.
 * Anonymous members (empty identity) hold no durable row and get live-only
 * delivery, but still see this shared seq/messageId.
 */
export function fanOutToInbox(
  core: EngineCore,
  opts: {
    channelName: string;
    channelFamily: string | null;
    event: string;
    payload: Record<string, unknown>;
  },
): { seq: number; messageId: string } | undefined {
  const config = core.inboxChannels.get(channelKeyFor(opts.channelName, opts.channelFamily));
  if (!config) return undefined;

  const frame: InboxFrame = {
    seq: inboxAllocator(core).next(),
    messageId: core.generateId('inbox'),
    event: opts.event,
    payload: opts.payload,
  };

  const { sql } = core.requireStorage();
  const identities = listIdentitiesByChannel(sql, opts.channelName, opts.channelFamily).filter(
    (identity) => identity !== '',
  );
  if (identities.length === 0) return { seq: frame.seq, messageId: frame.messageId };

  insertInboxRows(sql, {
    identities,
    channelName: opts.channelName,
    channelFamily: opts.channelFamily,
    frame,
    now: Date.now(),
  });

  if (config.retention) {
    for (const identity of identities) {
      applyRetention(core, {
        identity,
        channelName: opts.channelName,
        channelFamily: opts.channelFamily,
        config,
      });
    }
  }

  return { seq: frame.seq, messageId: frame.messageId };
}

/**
 * Re-deliver a reconnecting member's owed rows in seq order across every channel
 * it belongs to. Rows are not deleted on send — the client acks with
 * `__received__`, and that ack settles them.
 */
export function drainInboxOnReconnect(core: EngineCore, connection: RuntimeConnection): void {
  if (!connection.identity) return;
  const { sql } = core.requireStorage();
  const rows = loadUndeliveredRows(sql, connection.identity);
  if (rows.length === 0) return;

  for (const row of rows) {
    sendReplay(core, connection, {
      channelName: row.channelName,
      channelFamily: row.channelFamily,
      event: row.event,
      payload: JSON.parse(row.payload) as Record<string, unknown>,
      wire: {
        seq: row.seq,
        messageId: row.messageId,
        channel: row.channelName,
      },
    });
  }
}

/** Apply a member's `__received__` ack: drop or mark-delivered up to `receivedThrough`. */
export function applyInboxAck(
  sql: Pick<SQLProvider, 'exec'>,
  opts: {
    identity: string;
    channelName: string;
    channelFamily: string | null;
    receivedThrough: number;
    afterDelivered: ResolvedInboxOptions['afterDelivered'];
  },
): void {
  ackInboxRows(sql, {
    identity: opts.identity,
    channelName: opts.channelName,
    channelFamily: opts.channelFamily,
    receivedThrough: opts.receivedThrough,
    afterDelivered: opts.afterDelivered,
    now: Date.now(),
  });
}

/** Drop a member's rows for a channel it has left. */
export function clearInboxForChannel(
  core: EngineCore,
  key: { identity: string; channelName: string; channelFamily: string | null },
): void {
  if (!key.identity) return;
  if (!core.inboxChannels.has(channelKeyFor(key.channelName, key.channelFamily))) return;
  const { sql } = core.requireStorage();
  deleteInboxRowsForChannel(sql, key);
}

/**
 * Back an identity's inbox from a set of full frames. Each frame keeps its own
 * seq/messageId so ordering and dedup stay consistent with live traffic; the
 * rows drain on the member's next reconnect, or arrive live if it is connected.
 */
export function backfillInbox(
  sql: Pick<SQLProvider, 'exec'>,
  opts: {
    channelName: string;
    channelFamily: string | null;
    identity: string;
    frames: readonly InboxFrame[];
  },
): void {
  if (!opts.identity) return;
  insertInboxRowsForIdentity(sql, {
    identity: opts.identity,
    channelName: opts.channelName,
    channelFamily: opts.channelFamily,
    frames: opts.frames,
    now: Date.now(),
  });
}

function applyRetention(
  core: EngineCore,
  opts: {
    identity: string;
    channelName: string;
    channelFamily: string | null;
    config: ResolvedInboxOptions;
  },
): void {
  if (!opts.config.retention) return;
  const { sql } = core.requireStorage();
  const evictedThrough = pruneInboxRetention(sql, {
    identity: opts.identity,
    channelName: opts.channelName,
    channelFamily: opts.channelFamily,
    retention: opts.config.retention,
    now: Date.now(),
  });
  if (evictedThrough === null) return;

  bumpInboxWatermark(sql, {
    identity: opts.identity,
    channelName: opts.channelName,
    channelFamily: opts.channelFamily,
    evictedThroughSeq: evictedThrough,
  });

  // TODO(gap-branch): a parallel branch emits a `__gap__` frame to the member so
  // its client knows messages up to `evictedThrough` were dropped. Only the
  // watermark is raised here; the gap-frame emission belongs to that branch.
}
