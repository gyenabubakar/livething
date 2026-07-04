import { CAPABILITY_KIND } from '~/_define/capability-kinds.ts';
import { ENGINE_CHANNEL_META } from '~/_engine/contexts/types.ts';
import { applyInboxAck, backfillInbox } from '~/inbox/runtime.ts';
import { registerInboxRuntime } from '~/inbox/service.ts';
import { ensureInboxSchema } from '~/inbox/storage.ts';
import type { EngineAccess } from '~/_engine/access.ts';
import type { EngineChannelMeta } from '~/_engine/contexts/types.ts';
import type { ResolvedInboxOptions } from '~/_engine/runtime/feature-slots.ts';
import type * as Protocol from '~/_engine/runtime/protocol.ts';
import type { InboxFrame } from '~/inbox/storage.ts';
import type { InboxOptions } from '~/inbox/types.ts';
import type { Primitive } from '~/primitive.ts';

/** The primitive type produced by the `inbox()` capability for one channel. */
export interface InboxPrimitive extends Primitive<'inbox'> {
  readonly options: ResolvedInboxOptions;
}

/** @internal */
const INBOX_KEY = Symbol('inbox');

/** A full frame the developer hands `ctx.channel.inbox.backfill(...)`. */
interface BackfillFrame {
  event: string;
  payload: unknown;
  __wskit: { seq: number; messageId: string };
}

function resolveInboxOptions(config: InboxOptions): ResolvedInboxOptions {
  const afterDelivered = config.afterDelivered ?? 'delete';
  if (afterDelivered === 'keep' && !config.retention) {
    throw new Error(
      "[wskit] inbox `afterDelivered: 'keep'` requires `retention` so kept rows can age out.",
    );
  }
  return config.retention ? { afterDelivered, retention: config.retention } : { afterDelivered };
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
      engine.registerInboxChannel(channelKey, options);

      engine.onBootSchema(() => {
        ensureInboxSchema(engine.requireStorage().sql);
      });

      engine.extendContext(buildInboxContext(engine, channelKey));

      engine.onProtocolMessage(
        '__received__',
        buildReceivedHandler({ engine, channelKey, options }),
      );
    },
  };
}

/** Attach `ctx.channel.inbox.backfill(...)` when the live ctx is in this channel scope. */
function buildInboxContext(engine: EngineAccess, channelKey: string) {
  return (baseCtx: unknown): Record<string, unknown> => {
    const ctx = baseCtx as {
      channel?: Record<PropertyKey, unknown>;
      [ENGINE_CHANNEL_META]?: EngineChannelMeta;
    };
    const scope = ctx[ENGINE_CHANNEL_META];
    if (!ctx.channel || !scopeMatchesChannel(scope, channelKey)) return {};

    const channelName = scope?.channelName ?? channelKey;
    const channelFamily = scope?.channelFamily ?? null;

    ctx.channel.inbox = {
      backfill(identity: string, messages: readonly BackfillFrame[]): void {
        const frames: InboxFrame[] = messages.map((message) => ({
          seq: message.__wskit.seq,
          messageId: message.__wskit.messageId,
          event: message.event,
          payload: assertRecord(message.payload),
        }));
        backfillInbox(engine.requireStorage().sql, {
          channelName,
          channelFamily,
          identity,
          frames,
        });
      },
    };
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

    const identity = (ctx as { identity?: string }).identity ?? '';
    if (identity) {
      applyInboxAck(engine.requireStorage().sql, {
        identity,
        channelName: frame.__wskit.channel,
        channelFamily: frame.__wskit.channelFamily ?? null,
        receivedThrough: frame.payload.receivedThrough,
        afterDelivered: options.afterDelivered,
      });
    }

    // Not consumed: receipts (if listed) also observes `__received__` to advance
    // its cursor. Acks carry no reply, so an unconsumed frame is harmless.
    return false;
  };
}

function scopeMatchesChannel(scope: EngineChannelMeta | undefined, channelKey: string): boolean {
  return scope?.channelFamily === channelKey || scope?.channelName === channelKey;
}

function assertRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('[wskit] inbox backfill payload must be a plain object.');
  }
  return value as Record<string, unknown>;
}

/** Symbol identity for dependency declarations. */
inbox.__key = INBOX_KEY;
