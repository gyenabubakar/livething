import { CAPABILITY_KIND } from '~/_define/capability-kinds.ts';
import { ENGINE_CHANNEL_META, ENGINE_INTERNAL_CONNECTION } from '~/_engine/contexts/types.ts';
import { hasChannelMembership } from '~/channel/runtime.ts';
import {
  advanceReceivedThrough,
  advanceSeenThrough,
  ensureReceiptsSchema,
  listReceivedBy,
  listSeenBy,
} from '~/inbox/receipts-storage.ts';
import { applyInboxAck } from '~/inbox/runtime.ts';
import type { EngineAccess } from '~/_engine/access.ts';
import type { EngineChannelMeta } from '~/_engine/contexts/types.ts';
import type { ResolvedReceiptsOptions } from '~/_engine/runtime/feature-slots.ts';
import type * as Protocol from '~/_engine/runtime/protocol.ts';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';
import type { ReceiptCursors } from '~/inbox/receipts-storage.ts';
import type { ReceiptsOptions } from '~/inbox/types.ts';
import type { Primitive } from '~/primitive.ts';

/** The primitive type produced by the `receipts()` capability for one channel. */
export interface ReceiptsPrimitive extends Primitive<'receipts'> {
  readonly options: ResolvedReceiptsOptions;
}

/** @internal */
const RECEIPTS_KEY = Symbol('receipts');

function resolveReceiptsOptions(config: ReceiptsOptions): ResolvedReceiptsOptions {
  return config.broadcastUpTo !== undefined
    ? { seen: config.seen ?? false, broadcastUpTo: config.broadcastUpTo }
    : { seen: config.seen ?? false };
}

/**
 * The channel-scoped receipts primitive. Built by the `receipts()` capability
 * from a channel's `receipts` config. Requires `inbox` (and its transitive
 * `sequence`/`persistence`); the build fails without them.
 */
export function receipts(config: ReceiptsOptions): ReceiptsPrimitive {
  const options = resolveReceiptsOptions(config);

  return {
    __wskit: 'receipts',
    __kind: 'infrastructure',
    __identity: [RECEIPTS_KEY],
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
          '[wskit] receipts is channel-scoped; set `receipts` inside a channel definition.',
        );
      }

      engine.onBootSchema(() => {
        ensureReceiptsSchema(engine.requireStorage().sql);
      });

      engine.extendContext(buildReceiptsContext(engine, channelKey));

      engine.onProtocolMessage(
        '__received__',
        buildReceivedHandler({ engine, channelKey, options }),
      );
      engine.onProtocolMessage('__seen__', buildSeenHandler({ engine, channelKey, options }));
      engine.onProtocolMessage(
        '__receiptQuery__',
        buildReceiptQueryHandler({ engine, channelKey }),
      );
    },
  };
}

/** Attach `ctx.channel.receipts.seenBy(seq)` / `receivedBy(seq)` in this channel scope. */
function buildReceiptsContext(engine: EngineAccess, channelKey: string) {
  return (baseCtx: unknown): Record<string, unknown> => {
    const ctx = baseCtx as {
      channel?: Record<PropertyKey, unknown>;
      [ENGINE_CHANNEL_META]?: EngineChannelMeta;
    };
    const scope = ctx[ENGINE_CHANNEL_META];
    if (!ctx.channel || !scopeMatchesChannel(scope, channelKey)) return {};

    const channelName = scope?.channelName ?? channelKey;
    const channelFamily = scope?.channelFamily ?? null;

    ctx.channel.receipts = {
      receivedBy(seq: number): string[] {
        return listReceivedBy(engine.requireStorage().sql, { channelName, channelFamily, seq });
      },
      seenBy(seq: number): string[] {
        return listSeenBy(engine.requireStorage().sql, { channelName, channelFamily, seq });
      },
    };
    return {};
  };
}

interface ReceiptsHandlerDeps {
  engine: EngineAccess;
  channelKey: string;
  options: ResolvedReceiptsOptions;
}

function buildReceivedHandler(deps: ReceiptsHandlerDeps) {
  const { engine, channelKey, options } = deps;
  return (ctx: unknown, frame: Protocol.IncomingProtocolFrame): boolean => {
    if (frame.event !== '__received__') return false;
    const scope = (ctx as { [ENGINE_CHANNEL_META]?: EngineChannelMeta })[ENGINE_CHANNEL_META];
    if (!scopeMatchesChannel(scope, channelKey)) return false;

    const identity = (ctx as { identity?: string }).identity ?? '';
    if (!identity) return false;

    const channelName = frame.__wskit.channel;
    const channelFamily = frame.__wskit.channelFamily ?? null;
    const cursors = advanceReceivedThrough(engine.requireStorage().sql, {
      channelName,
      channelFamily,
      identity,
      receivedThrough: frame.payload.receivedThrough,
      now: Date.now(),
    });

    if (cursors.changed) {
      broadcastReceipt(engine, options, {
        channelName,
        channelFamily,
        identity,
        receivedThrough: cursors.receivedThrough,
      });
    }

    // Let the inbox handler also observe this ack — it owns row deletion.
    return false;
  };
}

function buildSeenHandler(deps: ReceiptsHandlerDeps) {
  const { engine, channelKey, options } = deps;
  return (ctx: unknown, frame: Protocol.IncomingProtocolFrame): boolean => {
    if (frame.event !== '__seen__') return false;
    const scope = (ctx as { [ENGINE_CHANNEL_META]?: EngineChannelMeta })[ENGINE_CHANNEL_META];
    if (!scopeMatchesChannel(scope, channelKey)) return false;
    if (!options.seen) return true;

    const identity = (ctx as { identity?: string }).identity ?? '';
    if (!identity) return true;

    const channelName = frame.__wskit.channel;
    const channelFamily = frame.__wskit.channelFamily ?? null;
    const cursors = advanceSeenThrough(engine.requireStorage().sql, {
      channelName,
      channelFamily,
      identity,
      seenThrough: frame.payload.seenThrough,
      now: Date.now(),
    });
    if (!cursors.changed) return true;

    broadcastReceipt(engine, options, {
      channelName,
      channelFamily,
      identity,
      receivedThrough: cursors.receivedThrough,
      seenThrough: cursors.seenThrough,
    });

    // Seen implies received, so settle the inbox up to the now-advanced
    // `received_through` with the channel's delete/keep lifecycle.
    advanceInboxOnSeen(engine, channelKey, { channelName, channelFamily, identity, cursors });
    return true;
  };
}

/**
 * Answer a client's `__receiptQuery__`: return who has received or seen up to a
 * given seq. Only a member of the channel may enumerate its readers — a
 * non-member is dropped silently, the same as an unauthorized ack. The reply
 * reuses the `__receiptQuery__` event name and echoes the query's correlationId.
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
 * cursor is still stored and stays queryable via `receivedBy` / `seenBy`.
 */
function broadcastReceipt(
  engine: EngineAccess,
  options: ResolvedReceiptsOptions,
  opts: {
    channelName: string;
    channelFamily: string | null;
    identity: string;
    receivedThrough?: number;
    seenThrough?: number;
  },
): void {
  if (
    options.broadcastUpTo !== undefined &&
    engine.channelMemberCount(opts.channelName, opts.channelFamily) > options.broadcastUpTo
  ) {
    return;
  }

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

/** Symbol identity for dependency declarations. */
receipts.__key = RECEIPTS_KEY;
