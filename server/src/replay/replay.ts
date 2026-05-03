/* oxlint-disable @typescript-eslint/no-explicit-any */
import { ENGINE_INTERNAL_CONNECTION } from '~/_engine/contexts/types.ts';
import { dedup } from '~/dedup/dedup.ts';
import {
  ensureReplaySchema,
  isChannelReplayAuthorized,
  loadReplayRows,
  matchesReplayScope,
  persistReplayMessage,
  pruneExpiredReplayRows,
  pruneReplayScopeRows,
  readReplayContextScope,
  readReplayPayloadScope,
  shouldStoreReplayMessage,
} from '~/replay/runtime.ts';
import { sequence } from '~/sequence/sequence.ts';
import type { EngineAccess } from '~/_engine/access.ts';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';
import type { ReplayWire } from '~/_types/scope-state';
import type { Primitive } from '~/primitive.ts';
import type { ReplayOptions } from '~/replay/types.ts';

/** The primitive type produced by `replay()`. */
export interface ReplayPrimitive extends Primitive<'replay'> {
  /** The full resolved replay configuration. */
  readonly options: ReplayOptions;
  /**
   * `true` when the developer registered `replay(false)` to opt out of cascade
   * for this scope. Disabled primitives carry no setup work; they only exist to
   * appear in the compile-time claimed-scope map so server-level replay knows
   * to skip this scope.
   */
  readonly disabled?: boolean;
}

/**
 * Convenience type for the function that re-sends one stored message to a
 * specific connection. Used by the replay context extension.
 */
export type ReplaySend = (event: string, payload: unknown, wire: ReplayWire) => void;

/** Unique symbol used to enforce one replay registration per handler scope. */
const REPLAY_KEY = Symbol('replay');

/**
 * Enables built-in message replay. The server records every outgoing message
 * so reconnecting clients can catch up on what they missed — wskit's client
 * asks for replay automatically on reconnect, and no extra work is needed
 * from your handlers.
 *
 * **Cascade behavior.** A server-level `.replay(...)` captures every outgoing
 * message, including channel-scoped traffic. To use a different replay
 * strategy for a specific channel, call `.replay(...)` inside that channel's
 * sub-builder — server-level skips channels that claim their own replay. To
 * opt a specific channel out of replay entirely, call `.replay(false)` inside
 * it; messages on that channel are not stored or replayed by either the
 * server-level or channel-level replay.
 *
 * Handlers also get `ctx.sendReplay()` for manually replaying a stored
 * message (e.g. in response to a "load older history" request).
 *
 * `sequence` and `dedup` are enabled automatically if you haven't already
 * registered them. Requires the `storage` platform capability.
 *
 * @example
 * ```ts
 * import { server } from '@wskit/server';
 * import { withReplay } from '@wskit/server/replay';
 *
 * withReplay(server('chat'))
 *   .replay((rb) => rb.retention({ maxAgeMs: 7 * 24 * 60 * 60 * 1000 }))
 *   .build();
 * ```
 */
export function replay(options?: ReplayOptions | false): ReplayPrimitive {
  if (options === false) {
    return {
      __wskit: 'replay',
      __kind: 'infrastructure',
      __identity: [REPLAY_KEY],
      __dependencies: [],
      __requires: {},
      options: {},
      disabled: true,
    };
  }

  const opts = options ?? {};

  return {
    __wskit: 'replay',
    __kind: 'infrastructure',
    __identity: [REPLAY_KEY],
    __dependencies: [sequence, dedup],
    __requires: { storage: true },
    options: opts,
    __setup(engine) {
      engine.setReplayEnabled(true);

      const { channelKey } = engine.getScopeInfo();
      const exclude = new Set(opts.exclude ?? []);

      engine.onBoot(() => {
        const { sql } = engine.requireStorage();
        ensureReplaySchema(sql);
        pruneExpiredReplayRows(sql, opts.retention, Date.now());
      });

      const installer = new ReplayInstaller(engine, channelKey, exclude, opts);

      engine.extendContext(installer.contextExtender);

      if ((opts.durability ?? 'strict') === 'strict') {
        engine.onBeforeSend(installer.persist);
      } else {
        engine.onAfterSend((wireMessage) => {
          return Promise.resolve().then(() => {
            installer.persist(wireMessage);
          });
        });
      }

      engine.onProtocolMessage('_replay', installer.protocolHandler);
    },
  };
}

/**
 * Bundles the context extender, persist callback, and `_replay` protocol
 * handler used during replay setup. Using a class lets the three callbacks
 * share the same engine reference, channel key, exclude set, and options
 * without repeating the constructor arguments.
 *
 * @internal
 */
class ReplayInstaller {
  constructor(
    private readonly engine: EngineAccess,
    private readonly channelKey: string | undefined,
    private readonly exclude: Set<string>,
    private readonly opts: ReplayOptions,
  ) {}

  /** Attach `sendReplay` to the relevant scope on every live connection context. */
  contextExtender = (ctx: unknown): Record<string, unknown> => {
    const base = ctx as Record<PropertyKey, unknown> & {
      id?: string;
      channel?: Record<PropertyKey, unknown>;
      sendReplay?: (event: string, payload: unknown, wire: ReplayWire) => void;
    };
    const scope = readReplayContextScope(base);

    if (this.channelKey) {
      // Channel-level replay. For families, channelKey is the family key and
      // matches scope.channelScope. For static channels, channelKey is the
      // channel name and matches scope.channelName (scope.channelScope is null).
      const matches =
        scope.channelScope === this.channelKey || scope.channelName === this.channelKey;
      if (!matches || !base.id || !base.channel) return {};

      base.channel.sendReplay = (event: string, payload: unknown, wire: ReplayWire) => {
        this.engine.sendReplay(
          base.id as string,
          scope.channelName ?? null,
          scope.channelScope ?? null,
          event,
          payload,
          wire,
        );
      };

      return {};
    }

    if (scope.namespaceName || scope.channelName || !base.id) return {};

    base.sendReplay = (event: string, payload: unknown, wire: ReplayWire) => {
      this.engine.sendReplay(
        base.id as string,
        wire.channel ?? null,
        wire.channelScope ?? null,
        event,
        payload,
        wire,
      );
    };

    return {};
  };

  /** Persist one outgoing wire message to the replay table. */
  persist = (wireMessage: { event: string; payload: Record<string, unknown> }): void => {
    if (
      !shouldStoreReplayMessage(
        this.channelKey,
        wireMessage.event,
        wireMessage.payload,
        this.exclude,
        this.engine.getReplayClaimedChannelKeys(),
      )
    )
      return;

    const { sql } = this.engine.requireStorage();
    const row = persistReplayMessage(
      sql,
      this.opts,
      wireMessage.event,
      wireMessage.payload,
      Date.now(),
    );
    pruneExpiredReplayRows(sql, this.opts.retention, row?.createdAt ?? Date.now());
    pruneReplayScopeRows(sql, this.opts.retention, readReplayPayloadScope(wireMessage.payload));
  };

  /** Handle the `_replay` protocol message by resending stored rows to the requester. */
  protocolHandler = async (
    ctx: unknown,
    payload: Record<string, unknown> | undefined,
  ): Promise<boolean> => {
    const scope = readReplayContextScope(ctx as Record<PropertyKey, unknown>);
    if (!matchesReplayScope(this.channelKey, scope, this.engine.getReplayClaimedChannelKeys())) {
      return false;
    }

    const connection = (ctx as Record<PropertyKey, unknown>)[ENGINE_INTERNAL_CONNECTION] as
      | RuntimeConnection
      | undefined;
    if (!isChannelReplayAuthorized(connection, scope, payload)) {
      // Silent ack: a non-member asking for channel replay gets no rows
      // and no error frame, matching the principle that the server should
      // not confirm channel existence to non-members.
      return true;
    }

    const since = Number(payload?.since ?? 0);
    const { sql } = this.engine.requireStorage();
    const rows = loadReplayRows(sql, since, {
      channelName: scope.channelName,
      channelScope: scope.channelScope ?? null,
    });
    const connectionId = String((ctx as Record<PropertyKey, unknown>).id ?? '');
    if (!connectionId) return true;

    for (const row of rows) {
      const rowPayload = JSON.parse(row.payload) as Record<string, unknown>;
      // Defense-in-depth: even if a stale store has 1:1 request responses
      // from before the persist-side filter landed, never resend them.
      if (typeof rowPayload._correlationId === 'string') continue;
      this.engine.sendReplay(connectionId, row.channel, row.channelScope, row.event, rowPayload, {
        seq: row.seq,
        messageId: row.messageId,
        channel: row.channel ?? undefined,
      });
    }

    return true;
  };
}

/**
 * Symbol key used to reference this primitive in dependency declarations.
 */
replay.__key = REPLAY_KEY;
