import { CAPABILITY_KIND } from '~/_define/capability-kinds.ts';
import { ENGINE_CHANNEL_META, ENGINE_INTERNAL_CONNECTION } from '~/_engine/contexts/types.ts';
import { hasChannelMembership } from '~/channel/runtime.ts';
import {
  advanceSeenThrough,
  ensureReceiptsSchema,
  listReceivedBy,
  listSeenBy,
} from '~/inbox/receipts-storage.ts';
import { applyInboxAck } from '~/inbox/runtime.ts';
import type { EngineAccess } from '~/_engine/access.ts';
import type { EngineChannelMeta } from '~/_engine/contexts/types.ts';
import type { ResolvedReadReceiptsOptions } from '~/_engine/runtime/feature-slots.ts';
import type * as Protocol from '~/_engine/runtime/protocol.ts';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';
import type { ReceiptCursors } from '~/inbox/receipts-storage.ts';
import type { Primitive } from '~/primitive.ts';

/** The primitive type produced by the `readReceipts()` capability for one channel. */
export interface ReadReceiptsPrimitive extends Primitive<'read-receipts'> {
  readonly options: ResolvedReadReceiptsOptions;
}

/** @internal */
const READ_RECEIPTS_KEY = Symbol('read-receipts');

/**
 * The channel-scoped read-receipts primitive. Built by the `readReceipts()`
 * capability from a channel's `readReceipts` config. It tracks only the seen
 * cursor (the blue check); delivered acknowledgement belongs to `inbox`.
 * Requires `inbox` (and its transitive `sequence`/`persistence`); the build
 * fails without them.
 */
export function readReceipts(options: ResolvedReadReceiptsOptions): ReadReceiptsPrimitive {
  return {
    __wskit: 'read-receipts',
    __kind: 'infrastructure',
    __identity: [READ_RECEIPTS_KEY],
    __requires: { storage: true },
    __requiresCapabilities: [
      CAPABILITY_KIND.inbox,
      CAPABILITY_KIND.sequence,
      CAPABILITY_KIND.persistence,
    ],
    options,
    __setup(engine) {
      const { channelKey } = engine.getScopeInfo();
      if (!channelKey) {
        throw new Error(
          '[wskit] readReceipts is channel-scoped; set `readReceipts` inside a channel definition.',
        );
      }

      engine.registerReadReceiptsChannel(channelKey);

      engine.onBootSchema(() => {
        ensureReceiptsSchema(engine.requireStorage().sql);
      });

      engine.extendContext(buildReadReceiptsContext(engine, channelKey));

      engine.onProtocolMessage('__seen__', buildSeenHandler({ engine, channelKey, options }));
      engine.onProtocolMessage(
        '__receiptQuery__',
        buildReceiptQueryHandler({ engine, channelKey }),
      );
    },
  };
}

/** Attach `ctx.channel.readReceipts.seenBy(seq)` in this channel scope. */
function buildReadReceiptsContext(engine: EngineAccess, channelKey: string) {
  return (baseCtx: unknown): Record<string, unknown> => {
    const ctx = baseCtx as {
      channel?: Record<PropertyKey, unknown>;
      [ENGINE_CHANNEL_META]?: EngineChannelMeta;
    };
    const scope = ctx[ENGINE_CHANNEL_META];
    if (!ctx.channel || !scopeMatchesChannel(scope, channelKey)) return {};

    const channelName = scope?.channelName ?? channelKey;
    const channelFamily = scope?.channelFamily ?? null;

    ctx.channel.readReceipts = {
      seenBy(seq: number): string[] {
        return listSeenBy(engine.requireStorage().sql, { channelName, channelFamily, seq });
      },
    };
    return {};
  };
}

interface SeenHandlerDeps {
  engine: EngineAccess;
  channelKey: string;
  options: ResolvedReadReceiptsOptions;
}

function buildSeenHandler(deps: SeenHandlerDeps) {
  const { engine, channelKey, options } = deps;
  return (ctx: unknown, frame: Protocol.IncomingProtocolFrame): boolean => {
    if (frame.event !== '__seen__') return false;
    const scope = (ctx as { [ENGINE_CHANNEL_META]?: EngineChannelMeta })[ENGINE_CHANNEL_META];
    if (!scopeMatchesChannel(scope, channelKey)) return false;

    const identity = (ctx as { identity?: string }).identity ?? '';
    if (!identity) return true;

    const channelName = frame.__wskit.channel;
    const channelFamily = frame.__wskit.channelFamily ?? null;
    if (!isMember(ctx, channelName, channelFamily)) return true;

    const cursors = advanceSeenThrough(engine.requireStorage().sql, {
      channelName,
      channelFamily,
      identity,
      seenThrough: frame.payload.seenThrough,
      now: Date.now(),
    });
    if (!cursors.changed) return true;

    broadcastReceipt(engine, options.broadcastUpTo, {
      channelName,
      channelFamily,
      identity,
      receivedThrough: cursors.receivedThrough,
      seenThrough: cursors.seenThrough,
    });

    // Seen implies received, so settle the inbox up to the advanced mark too.
    advanceInboxOnSeen(engine, channelKey, { channelName, channelFamily, identity, cursors });
    return true;
  };
}

/**
 * Answer a client's `__receiptQuery__`: return who has received or seen up to a
 * given seq. Only a member of the channel may enumerate its readers — a
 * non-member is dropped silently, the same as an unauthorized ack. The reply
 * reuses the `__receiptQuery__` event name and echoes the query's correlationId.
 * `received` is answered here too so a channel with `readReceipts` (which always
 * has `inbox`) can serve both queries through one handler.
 */
function buildReceiptQueryHandler(deps: { engine: EngineAccess; channelKey: string }) {
  const { engine, channelKey } = deps;
  return (ctx: unknown, frame: Protocol.IncomingProtocolFrame): boolean => {
    if (frame.event !== '__receiptQuery__') return false;
    const scope = (ctx as { [ENGINE_CHANNEL_META]?: EngineChannelMeta })[ENGINE_CHANNEL_META];
    if (!scopeMatchesChannel(scope, channelKey)) return false;

    const channelName = frame.__wskit.channel;
    const channelFamily = frame.__wskit.channelFamily ?? null;
    const connection = (ctx as { [ENGINE_INTERNAL_CONNECTION]?: RuntimeConnection })[
      ENGINE_INTERNAL_CONNECTION
    ];
    if (!connection || !hasChannelMembership(connection, channelName, channelFamily)) return true;

    const { seq, kind } = frame.payload;
    const sql = engine.requireStorage().sql;
    const identities =
      kind === 'seen'
        ? listSeenBy(sql, { channelName, channelFamily, seq })
        : listReceivedBy(sql, { channelName, channelFamily, seq });

    const wskit: Record<string, unknown> = {
      channel: channelName,
      correlationId: frame.__wskit.correlationId,
    };
    if (channelFamily !== null) wskit.channelFamily = channelFamily;
    engine.sendProtocolFrame(connection.id, {
      event: '__receiptQuery__',
      payload: { identities },
      wskit,
    });
    return true;
  };
}

/**
 * Broadcast a `__receipt__` presence frame to the channel's live members, but
 * only while the member count is within `broadcastUpTo`. Above the threshold the
 * cursor is still stored and stays queryable via `receivedBy` / `seenBy`. Shared
 * by inbox's delivered tick and the read-receipts tick.
 */
export function broadcastReceipt(
  engine: EngineAccess,
  broadcastUpTo: number,
  opts: {
    channelName: string;
    channelFamily: string | null;
    identity: string;
    receivedThrough?: number;
    seenThrough?: number;
  },
): void {
  if (engine.channelMemberCount(opts.channelName, opts.channelFamily) > broadcastUpTo) return;

  const payload: Record<string, unknown> = { identity: opts.identity };
  if (opts.receivedThrough !== undefined) payload.receivedThrough = opts.receivedThrough;
  if (opts.seenThrough !== undefined) payload.seenThrough = opts.seenThrough;

  engine.broadcastToChannel({
    channelName: opts.channelName,
    channelFamily: opts.channelFamily,
    event: '__receipt__',
    payload,
  });
}

/**
 * When `__seen__` pulls `received_through` up (seen implies received), settle
 * the member's inbox rows up to the new mark using the inbox capability's own
 * ack, so the delete/keep lifecycle stays consistent with a plain `__received__`.
 */
function advanceInboxOnSeen(
  engine: EngineAccess,
  channelKey: string,
  opts: {
    channelName: string;
    channelFamily: string | null;
    identity: string;
    cursors: ReceiptCursors;
  },
): void {
  const inboxConfig = engine.getInboxChannel(channelKey);
  if (!inboxConfig) return;
  applyInboxAck(engine.requireStorage().sql, {
    identity: opts.identity,
    channelName: opts.channelName,
    channelFamily: opts.channelFamily,
    receivedThrough: opts.cursors.receivedThrough,
    afterDelivered: inboxConfig.afterDelivered,
  });
}

function scopeMatchesChannel(scope: EngineChannelMeta | undefined, channelKey: string): boolean {
  return scope?.channelFamily === channelKey || scope?.channelName === channelKey;
}

/**
 * A `__seen__` ack may advance the cursor and force a `__receipt__` broadcast, so
 * — like `__receiptQuery__` — it must come from a current member. A socket that
 * has left or been kicked but still holds the connection is dropped.
 */
function isMember(ctx: unknown, channelName: string, channelFamily: string | null): boolean {
  const connection = (ctx as { [ENGINE_INTERNAL_CONNECTION]?: RuntimeConnection })[
    ENGINE_INTERNAL_CONNECTION
  ];
  return !!connection && hasChannelMembership(connection, channelName, channelFamily);
}

/** Symbol identity for dependency declarations. */
readReceipts.__key = READ_RECEIPTS_KEY;
