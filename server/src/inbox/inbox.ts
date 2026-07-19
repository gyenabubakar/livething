import { CAPABILITY_KIND } from '~/_define/capability-kinds.ts';
import { ENGINE_CHANNEL_META, ENGINE_INTERNAL_CONNECTION } from '~/_engine/contexts/contexts.ts';
import { hasChannelMembership } from '~/channel/runtime.ts';
import { registerInboxHandleAugmenter } from '~/inbox/augment.ts';
import { broadcastReceipt } from '~/inbox/receipts-broadcast.ts';
import {
  advanceReceivedThrough,
  ensureReceiptsSchema,
  listReceivers,
} from '~/inbox/receipts-storage.ts';
import { applyInboxAck, DEFAULT_MAX_RECEIPT_AUDIENCE } from '~/inbox/runtime.ts';
import { registerInboxRuntime } from '~/inbox/service.ts';
import { ensureInboxSchema } from '~/inbox/storage.ts';
import { buildInboxSurface } from '~/inbox/surface.ts';
import type { EngineAccess } from '~/_engine/access.ts';
import type { EngineChannelMeta } from '~/_engine/contexts/types.ts';
import type { ResolvedInboxOptions } from '~/_engine/runtime/feature-slots.ts';
import type * as Protocol from '~/_engine/runtime/protocol.ts';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';
import type { InboxOptions } from '~/inbox/types.ts';
import type { Primitive } from '~/primitive.ts';

/** The primitive type produced by the `inbox()` capability for one channel. */
export interface InboxPrimitive extends Primitive<'inbox'> {
  readonly options: ResolvedInboxOptions;
}

/** @internal */
const INBOX_KEY = Symbol('inbox');

function resolveInboxOptions(config: InboxOptions): ResolvedInboxOptions {
  const onDelivered = config.onDelivered ?? 'delete';
  if (onDelivered === 'retain' && !config.retention) {
    throw new Error(
      "[wskit] inbox `onDelivered: 'retain'` requires `retention` so kept rows can age out.",
    );
  }
  const broadcastReceipts = config.broadcastReceipts ?? false;
  const maxReceiptAudience = config.maxReceiptAudience ?? DEFAULT_MAX_RECEIPT_AUDIENCE;
  return config.retention
    ? { onDelivered, retention: config.retention, broadcastReceipts, maxReceiptAudience }
    : { onDelivered, broadcastReceipts, maxReceiptAudience };
}

/**
 * The channel-scoped inbox primitive. Built by the `inbox()` capability from a
 * channel's `inbox` config; you do not call it directly. Requires `channels`,
 * `persistence`, `sequence({ persist: true })`, and `dedup` — the build fails
 * fast without them.
 */
export function inbox(config: InboxOptions): InboxPrimitive {
  const options = resolveInboxOptions(config);

  return {
    __wskit: 'inbox',
    __kind: 'infrastructure',
    __identity: [INBOX_KEY],
    __requires: { storage: true },
    __requiresCapabilities: [
      CAPABILITY_KIND.channels,
      CAPABILITY_KIND.persistence,
      CAPABILITY_KIND.sequence,
      CAPABILITY_KIND.dedup,
    ],
    __validate(view) {
      if (!view.sequencePersistent) {
        throw new Error(
          '[wskit] inbox requires `sequence: { persist: true }` for durable delivery.',
        );
      }
    },
    options,
    __setup(engine) {
      const { channelKey } = engine.getScopeInfo();
      if (!channelKey) {
        throw new Error(
          '[wskit] inbox is channel-scoped; set `inbox` inside a channel definition.',
        );
      }

      registerInboxRuntime(engine);
      registerInboxHandleAugmenter(engine);
      engine.registerInboxChannel(channelKey, options);

      engine.onBootSchema(() => {
        ensureInboxSchema(engine.requireStorage().sql);
        ensureReceiptsSchema(engine.requireStorage().sql);
      });

      engine.extendContext(buildInboxContext(engine, channelKey));

      engine.onProtocolMessage(
        '__received__',
        buildReceivedHandler({ engine, channelKey, options }),
      );
      engine.onProtocolMessage(
        '__receivedQuery__',
        buildReceivedQueryHandler({ engine, channelKey }),
      );
    },
  };
}

/**
 * Attach the non-null `ctx.channel.inbox` member (backfill / receiversOf /
 * backlog) in this channel's owning scope. The handle-augmenter adds the
 * nullable `ctx.channel.inbox()` method on every handle; this keeps the direct
 * member for the owning scope.
 */
function buildInboxContext(engine: EngineAccess, channelKey: string) {
  return (baseCtx: unknown): Record<string, unknown> => {
    const ctx = baseCtx as {
      channel?: Record<PropertyKey, unknown>;
      [ENGINE_CHANNEL_META]?: EngineChannelMeta;
    };
    const scope = ctx[ENGINE_CHANNEL_META];
    if (!ctx.channel || !scopeMatchesChannel(scope, channelKey)) return {};

    ctx.channel.inbox = buildInboxSurface(engine, {
      channelName: scope?.channelName ?? channelKey,
      channelFamily: scope?.channelFamily ?? null,
    });
    return {};
  };
}

function buildReceivedHandler(deps: {
  engine: EngineAccess;
  channelKey: string;
  options: ResolvedInboxOptions;
}) {
  const { engine, channelKey, options } = deps;
  return (ctx: unknown, frame: Protocol.IncomingProtocolFrame): boolean => {
    if (frame.event !== '__received__') return false;
    const scope = (ctx as { [ENGINE_CHANNEL_META]?: EngineChannelMeta })[ENGINE_CHANNEL_META];
    if (!scopeMatchesChannel(scope, channelKey)) return false;

    const userId = (ctx as { user?: { id?: string } }).user?.id ?? '';
    const channelName = frame.__wskit.channel;
    const channelFamily = frame.__wskit.channelFamily ?? null;
    if (userId && isMember(ctx, channelName, channelFamily)) {
      applyInboxAck(engine.requireStorage().sql, {
        userId,
        channelName,
        channelFamily,
        receivedThrough: frame.payload.receivedThrough,
        onDelivered: options.onDelivered,
      });

      const cursors = advanceReceivedThrough(
        engine.requireStorage().sql,
        {
          channelName,
          channelFamily,
          userId,
          receivedThrough: frame.payload.receivedThrough,
          now: Date.now(),
        },
        engine.receiptCursorCache?.(),
      );
      if (cursors.changed && options.broadcastReceipts) {
        broadcastReceipt(engine, options.maxReceiptAudience, {
          channelName,
          channelFamily,
          event: '__received__',
          payload: { userId, receivedThrough: cursors.receivedThrough },
        });
      }
    }

    // Return false so read-receipts (if listed) can also observe this ack.
    return false;
  };
}

/**
 * Answer a client's `__receivedQuery__`: return who has received up to a given
 * seq. Only a member of the channel may enumerate its receivers — a non-member
 * is dropped silently, the same as an unauthorized ack. The reply reuses the
 * `__receivedQuery__` event name and echoes the query's correlationId. Owned by
 * `inbox()`, so it works with or without `readReceipts()` present.
 */
function buildReceivedQueryHandler(deps: { engine: EngineAccess; channelKey: string }) {
  const { engine, channelKey } = deps;
  return (ctx: unknown, frame: Protocol.IncomingProtocolFrame): boolean => {
    if (frame.event !== '__receivedQuery__') return false;
    const scope = (ctx as { [ENGINE_CHANNEL_META]?: EngineChannelMeta })[ENGINE_CHANNEL_META];
    if (!scopeMatchesChannel(scope, channelKey)) return false;

    const channelName = frame.__wskit.channel;
    const channelFamily = frame.__wskit.channelFamily ?? null;
    const connection = (ctx as { [ENGINE_INTERNAL_CONNECTION]?: RuntimeConnection })[
      ENGINE_INTERNAL_CONNECTION
    ];
    if (!connection || !hasChannelMembership(connection, channelName, channelFamily)) return true;

    const userIds = listReceivers(engine.requireStorage().sql, {
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
      event: '__receivedQuery__',
      payload: { userIds },
      wskit,
    });
    return true;
  };
}

function scopeMatchesChannel(scope: EngineChannelMeta | undefined, channelKey: string): boolean {
  return scope?.channelFamily === channelKey || scope?.channelName === channelKey;
}

/** True when the acking socket is still a current member of the channel. */
function isMember(ctx: unknown, channelName: string, channelFamily: string | null): boolean {
  const connection = (ctx as { [ENGINE_INTERNAL_CONNECTION]?: RuntimeConnection })[
    ENGINE_INTERNAL_CONNECTION
  ];
  return !!connection && hasChannelMembership(connection, channelName, channelFamily);
}

/** Symbol identity for dependency declarations. */
inbox.__key = INBOX_KEY;
