import { CAPABILITY_KIND } from '~/_define/capability-kinds.ts';
import { ENGINE_CHANNEL_META, ENGINE_INTERNAL_CONNECTION } from '~/_engine/contexts/contexts.ts';
import { hasChannelMembership } from '~/channel/runtime.ts';
import { registerReadReceiptsHandleAugmenter } from '~/inbox/read-receipts-augment.ts';
import { buildReadReceiptsSurface } from '~/inbox/read-receipts-surface.ts';
import { broadcastReceipt } from '~/inbox/receipts-broadcast.ts';
import { advanceReadThrough, listReaders } from '~/inbox/receipts-storage.ts';
import { applyInboxAck } from '~/inbox/runtime.ts';
import type { EngineAccess } from '~/_engine/access.ts';
import type { EngineChannelMeta } from '~/_engine/contexts/types.ts';
import type {
  ResolvedInboxOptions,
  ResolvedReadReceiptsOptions,
} from '~/_engine/runtime/feature-slots.ts';
import type * as Protocol from '~/_engine/runtime/protocol.ts';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';
import type { AdvancedReadCursors } from '~/inbox/receipts-storage.ts';
import type { Primitive } from '~/primitive.ts';

/** The primitive type produced by the `readReceipts()` capability for one channel. */
export interface ReadReceiptsPrimitive extends Primitive<'read-receipts'> {
  readonly options: ResolvedReadReceiptsOptions;
}

/** @internal */
const READ_RECEIPTS_KEY = Symbol('read-receipts');

/**
 * The channel-scoped read-receipts primitive. Built by the `readReceipts()`
 * capability from a channel's `readReceipts` config. It tracks only the read
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
      registerReadReceiptsHandleAugmenter(engine);

      engine.extendContext(buildReadReceiptsContext(engine, channelKey));

      engine.onProtocolMessage('__read__', buildReadHandler({ engine, channelKey, options }));
      engine.onProtocolMessage('__readQuery__', buildReadQueryHandler({ engine, channelKey }));
    },
  };
}

/**
 * Attach the non-null `ctx.channel.readReceipts` member (readersOf) in this
 * channel's owning scope. The handle-augmenter adds the nullable
 * `ctx.channel.readReceipts()` method on every handle; this keeps the direct
 * member for the owning scope.
 */
function buildReadReceiptsContext(engine: EngineAccess, channelKey: string) {
  return (baseCtx: unknown): Record<string, unknown> => {
    const ctx = baseCtx as {
      channel?: Record<PropertyKey, unknown>;
      [ENGINE_CHANNEL_META]?: EngineChannelMeta;
    };
    const scope = ctx[ENGINE_CHANNEL_META];
    if (!ctx.channel || !scopeMatchesChannel(scope, channelKey)) return {};

    ctx.channel.readReceipts = buildReadReceiptsSurface(engine, {
      channelName: scope?.channelName ?? channelKey,
      channelFamily: scope?.channelFamily ?? null,
    });
    return {};
  };
}

interface ReadHandlerDeps {
  engine: EngineAccess;
  channelKey: string;
  options: ResolvedReadReceiptsOptions;
}

function buildReadHandler(deps: ReadHandlerDeps) {
  const { engine, channelKey, options } = deps;
  return (ctx: unknown, frame: Protocol.IncomingProtocolFrame): boolean => {
    if (frame.event !== '__read__') return false;
    const scope = (ctx as { [ENGINE_CHANNEL_META]?: EngineChannelMeta })[ENGINE_CHANNEL_META];
    if (!scopeMatchesChannel(scope, channelKey)) return false;

    const identity = (ctx as { identity?: string }).identity ?? '';
    if (!identity) return true;

    const channelName = frame.__wskit.channel;
    const channelFamily = frame.__wskit.channelFamily ?? null;
    if (!isMember(ctx, channelName, channelFamily)) return true;

    const cursors = advanceReadThrough(
      engine.requireStorage().sql,
      {
        channelName,
        channelFamily,
        identity,
        readThrough: frame.payload.readThrough,
        now: Date.now(),
      },
      engine.receiptCursorCache?.(),
    );
    if (!cursors.changed) return true;

    broadcastReceipt(engine, options.maxReceiptAudience, {
      channelName,
      channelFamily,
      event: '__read__',
      payload: { identity, readThrough: cursors.readThrough },
    });

    // Read implies received, so a read mark can pull received up and settle the
    // held inbox rows; the `__received__` tick is then inbox's to send.
    if (cursors.receivedChanged) {
      const inboxConfig = settleInboxOnRead(engine, channelKey, {
        channelName,
        channelFamily,
        identity,
        cursors,
      });
      if (inboxConfig?.broadcastReceipts) {
        broadcastReceipt(engine, inboxConfig.maxReceiptAudience, {
          channelName,
          channelFamily,
          event: '__received__',
          payload: { identity, receivedThrough: cursors.receivedThrough },
        });
      }
    }
    return true;
  };
}

/**
 * Answer a client's `__readQuery__`: return who has read up to a given seq. Only
 * a member of the channel may enumerate its readers — a non-member is dropped
 * silently, the same as an unauthorized ack. The reply reuses the `__readQuery__`
 * event name and echoes the query's correlationId.
 */
function buildReadQueryHandler(deps: { engine: EngineAccess; channelKey: string }) {
  const { engine, channelKey } = deps;
  return (ctx: unknown, frame: Protocol.IncomingProtocolFrame): boolean => {
    if (frame.event !== '__readQuery__') return false;
    const scope = (ctx as { [ENGINE_CHANNEL_META]?: EngineChannelMeta })[ENGINE_CHANNEL_META];
    if (!scopeMatchesChannel(scope, channelKey)) return false;

    const channelName = frame.__wskit.channel;
    const channelFamily = frame.__wskit.channelFamily ?? null;
    const connection = (ctx as { [ENGINE_INTERNAL_CONNECTION]?: RuntimeConnection })[
      ENGINE_INTERNAL_CONNECTION
    ];
    if (!connection || !hasChannelMembership(connection, channelName, channelFamily)) return true;

    const identities = listReaders(engine.requireStorage().sql, {
      channelName,
      channelFamily,
      seq: frame.payload.seq,
    });

    const wskit: Record<string, unknown> = {
      channel: channelName,
      correlationId: frame.__wskit.correlationId,
    };
    if (channelFamily !== null) wskit.channelFamily = channelFamily;
    engine.sendProtocolFrame(connection.id, {
      event: '__readQuery__',
      payload: { identities },
      wskit,
    });
    return true;
  };
}

/**
 * When `__read__` pulls `received_through` up (read implies received), settle
 * the member's inbox rows up to the new mark using the inbox capability's own
 * ack, so the delete/retain lifecycle stays consistent with a plain `__received__`.
 * Returns the inbox config so the caller can honor its receipt-broadcast settings.
 */
function settleInboxOnRead(
  engine: EngineAccess,
  channelKey: string,
  opts: {
    channelName: string;
    channelFamily: string | null;
    identity: string;
    cursors: AdvancedReadCursors;
  },
): ResolvedInboxOptions | undefined {
  const inboxConfig = engine.getInboxChannel(channelKey);
  if (!inboxConfig) return undefined;
  applyInboxAck(engine.requireStorage().sql, {
    identity: opts.identity,
    channelName: opts.channelName,
    channelFamily: opts.channelFamily,
    receivedThrough: opts.cursors.receivedThrough,
    onDelivered: inboxConfig.onDelivered,
  });
  return inboxConfig;
}

function scopeMatchesChannel(scope: EngineChannelMeta | undefined, channelKey: string): boolean {
  return scope?.channelFamily === channelKey || scope?.channelName === channelKey;
}

/**
 * A `__read__` ack may advance the cursor and force a fan-out, so — like
 * `__readQuery__` — it must come from a current member. A socket that has left or
 * been kicked but still holds the connection is dropped.
 */
function isMember(ctx: unknown, channelName: string, channelFamily: string | null): boolean {
  const connection = (ctx as { [ENGINE_INTERNAL_CONNECTION]?: RuntimeConnection })[
    ENGINE_INTERNAL_CONNECTION
  ];
  return !!connection && hasChannelMembership(connection, channelName, channelFamily);
}

/** Symbol identity for dependency declarations. */
readReceipts.__key = READ_RECEIPTS_KEY;
