import { CAPABILITY_KIND } from '~/_define/capability-kinds.ts';
import { ENGINE_CHANNEL_META, ENGINE_INTERNAL_CONNECTION } from '~/_engine/contexts/contexts.ts';
import { assertOptionalPositiveInteger } from '~/_engine/validation.ts';
import { hasChannelMembership } from '~/channel/runtime.ts';
import { registerInboxHandleAugmenter } from '~/inbox/augment.ts';
import { broadcastReceipt } from '~/inbox/receipts-broadcast.ts';
import {
  advanceReceivedThrough,
  ensureReceiptsSchema,
  listReceivers,
} from '~/inbox/receipts-storage.ts';
import {
  applyInboxAck,
  DEFAULT_MAX_RECEIPT_AUDIENCE,
  nextInboxRetentionDeadline,
  scopeMatchesChannel,
  sweepInboxRetention,
} from '~/inbox/runtime.ts';
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

type BuildReceivedHandlerDepsParameter = {
  engine: EngineAccess;
  channelKey: string;
  options: ResolvedInboxOptions;
};
type BuildReceivedQueryHandlerDepsParameter = { engine: EngineAccess; channelKey: string };

/** The primitive type produced by the `inbox()` capability for one channel. */
export interface InboxPrimitive extends Primitive<'inbox'> {}

/** @internal */
const INBOX_KEY = Symbol('inbox');

export function resolveInboxOptions(config: InboxOptions): ResolvedInboxOptions {
  if (config.retention) {
    assertOptionalPositiveInteger(config.retention.maxAgeMs, 'retention.maxAgeMs', 'inbox()');
    assertOptionalPositiveInteger(config.retention.maxMessages, 'retention.maxMessages', 'inbox()');
  }

  const broadcastReceipts = config.broadcastReceipts ?? false;
  const maxReceiptAudience = config.maxReceiptAudience ?? DEFAULT_MAX_RECEIPT_AUDIENCE;

  return config.retention
    ? { retention: config.retention, broadcastReceipts, maxReceiptAudience }
    : { broadcastReceipts, maxReceiptAudience };
}

/**
 * The channel-scoped inbox primitive. Built by the `inbox()` capability from a
 * channel's `inbox` config; you do not call it directly. Requires `channels`,
 * `sequence({ persist: true })`, and `dedup` — the build fails fast without
 * them.
 */
export function inbox(config: InboxOptions): InboxPrimitive {
  const options = resolveInboxOptions(config);

  return {
    __livething: 'inbox',
    __identity: [INBOX_KEY],
    __requires: {},
    __requiresCapabilities: [
      CAPABILITY_KIND.channels,
      CAPABILITY_KIND.sequence,
      CAPABILITY_KIND.dedup,
    ],
    __validate(view) {
      if (!view.sequencePersistent) {
        throw new Error(
          '[livething] inbox needs a persistent sequence for durable delivery. List ' +
            'sequence({ persist: true }) in server({ capabilities: [...] }) instead of sequence().',
        );
      }

      if (view.channelKey && !view.isChannelDurable(view.channelKey)) {
        throw new Error(
          `[livething] Channel "${view.channelKey}" has inbox() but is not persistent, so guaranteed ` +
            `delivery silently degrades to live-only — inbox fans out to the durable membership roster, ` +
            `which stays empty on an ephemeral channel. Set \`membership: 'persistent'\` on this ` +
            `channel, or remove inbox().`,
        );
      }
    },
    __setup(engine) {
      const { channelKey } = engine.getScopeInfo();
      if (!channelKey) {
        throw new Error(
          '[livething] inbox is channel-scoped; set `inbox` inside a channel definition.',
        );
      }

      registerInboxRuntime(engine);
      registerInboxHandleAugmenter(engine);
      engine.registerInboxChannel(channelKey, options);

      const maxAgeMs = options.retention?.maxAgeMs;
      if (maxAgeMs !== undefined) {
        const retentionAlarmKey = Symbol(`inbox-retention:${channelKey}`);
        engine.registerAlarmSource(retentionAlarmKey, () =>
          nextInboxRetentionDeadline(engine.storage.sql, { channelKey, maxAgeMs }),
        );
        engine.onAlarm(() => {
          sweepInboxRetention(engine.storage.sql, {
            channelKey,
            retention: options.retention!,
            now: Date.now(),
          });
        });
      }

      if (options.retention) {
        // Run every configured retention bound at boot. This matters when a
        // deployment changes maxMessages while the object is quiet: count-only
        // retention has no alarm source, so its only reconciliation point is
        // the next boot.
        engine.onBoot(() => {
          sweepInboxRetention(engine.storage.sql, {
            channelKey,
            retention: options.retention!,
            now: Date.now(),
          });
        });
      }

      engine.onBootSchema(() => {
        ensureInboxSchema(engine.storage.sql);
        ensureReceiptsSchema(engine.storage.sql);
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
    if (!ctx.channel || !scopeMatchesChannel(scope, channelKey) || scope?.isSubscribeGate) {
      return {};
    }

    ctx.channel.inbox = buildInboxSurface(engine, {
      channelName: scope?.channelName ?? channelKey,
      channelFamily: scope?.channelFamily ?? null,
    });

    return {};
  };
}

function buildReceivedHandler(deps: BuildReceivedHandlerDepsParameter) {
  const { engine, channelKey, options } = deps;
  return (ctx: unknown, frame: Protocol.IncomingProtocolFrame): boolean => {
    if (frame.event !== '__received__') return false;

    const scope = (ctx as { [ENGINE_CHANNEL_META]?: EngineChannelMeta })[ENGINE_CHANNEL_META];
    if (!scopeMatchesChannel(scope, channelKey)) return false;

    const connection = (ctx as { [ENGINE_INTERNAL_CONNECTION]?: RuntimeConnection })[
      ENGINE_INTERNAL_CONNECTION
    ];
    const userId = connection?.userId ?? '';
    const channelName = frame.__livething.channel;
    const channelFamily = frame.__livething.channelFamily ?? null;
    if (userId && isMember(connection, channelName, channelFamily)) {
      applyInboxAck(engine.storage.sql, {
        userId,
        channelName,
        channelFamily,
        receivedThrough: frame.payload.receivedThrough,
      });
      engine.invalidateInboxMemberCount?.(channelName, channelFamily, userId);

      const cursors = advanceReceivedThrough(
        engine.storage.sql,
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
function buildReceivedQueryHandler(deps: BuildReceivedQueryHandlerDepsParameter) {
  const { engine, channelKey } = deps;
  return (ctx: unknown, frame: Protocol.IncomingProtocolFrame): boolean => {
    if (frame.event !== '__receivedQuery__') return false;

    const scope = (ctx as { [ENGINE_CHANNEL_META]?: EngineChannelMeta })[ENGINE_CHANNEL_META];
    if (!scopeMatchesChannel(scope, channelKey)) return false;

    const channelName = frame.__livething.channel;
    const channelFamily = frame.__livething.channelFamily ?? null;
    const connection = (ctx as { [ENGINE_INTERNAL_CONNECTION]?: RuntimeConnection })[
      ENGINE_INTERNAL_CONNECTION
    ];
    if (!connection || !hasChannelMembership(connection, channelName, channelFamily)) return true;

    const userIds = listReceivers(engine.storage.sql, {
      channelName,
      channelFamily,
      seq: frame.payload.seq,
    });

    const livething: Record<string, unknown> = {
      channel: channelName,
      correlationId: frame.__livething.correlationId,
    };

    if (channelFamily !== null) livething.channelFamily = channelFamily;
    engine.sendProtocolFrame(connection.id, {
      event: '__receivedQuery__',
      payload: { userIds },
      livething,
    });

    return true;
  };
}

/** True when the acking socket is still a current member of the channel. */
function isMember(
  connection: RuntimeConnection | undefined,
  channelName: string,
  channelFamily: string | null,
): boolean {
  return !!connection && hasChannelMembership(connection, channelName, channelFamily);
}
