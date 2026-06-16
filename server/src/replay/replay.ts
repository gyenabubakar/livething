/* oxlint-disable @typescript-eslint/no-explicit-any */
import { ENGINE_INTERNAL_CONNECTION } from '~/_engine/contexts/types.ts';
import { assertOneOf, assertOptionalPositiveInteger } from '~/_engine/validation.ts';
import {
  ensureReplaySchema,
  isChannelReplayAuthorized,
  loadReplayRows,
  matchesReplayScope,
  persistReplayMessage,
  pruneExpiredReplayRows,
  pruneReplayScopeRows,
  readReplayContextScope,
  readReplayScope,
  shouldStoreReplayMessage,
} from '~/replay/runtime.ts';
import type { EngineAccess } from '~/_engine/access.ts';
import type * as Protocol from '~/_engine/runtime/protocol.ts';
import type { RuntimeConnection, WireOutgoingMessage } from '~/_engine/runtime/types.ts';
import type { SQLProvider } from '~/context.ts';
import type { Primitive } from '~/primitive.ts';
import type { ReplayOptions } from '~/replay/types.ts';
import type { ReplayWire } from './wire.ts';

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
 * so reconnecting clients can catch up on what they missed — WSKit's client
 * asks for replay automatically on reconnect, and no extra work is needed
 * from your handlers.
 *
 * **Cascade behavior.** A server-level `replay: true` captures every outgoing
 * message, including channel-scoped traffic. To use a different replay
 * strategy for one channel, add `replay: true` inside that channel's
 * `definitions` — the server-level replay then skips that channel. To opt a
 * specific channel out of replay entirely, add `replay: false` inside its
 * `definitions`; messages on that channel are not stored or replayed by
 * either the server-level or channel-level replay.
 *
 * Handlers also get `ctx.sendReplay()` for manually replaying a stored
 * message (e.g. in response to a "load older history" request).
 *
 * Replay requires the `dedup()` and `sequence({ persist: true })` capabilities —
 * dedup stamps the `messageId` replay keys off, and persistent sequence keeps
 * `seq` stable across restarts so stored rows order correctly. The build fails
 * fast if either is missing. Also requires the `storage` platform capability.
 *
 * Enable this by listing the `replay.history({...})` capability instead of
 * calling this primitive directly.
 *
 * @example
 * ```ts
 * import { define, t } from '@wskit/server';
 * import { dedup } from '@wskit/server/dedup';
 * import { sequence } from '@wskit/server/sequence';
 * import { replay } from '@wskit/server/replay';
 *
 * const base = define({
 *   env: t<Env>(),
 *   capabilities: [
 *     dedup(),
 *     sequence({ persist: true }),
 *     replay.history({ retention: { maxAgeMs: 7 * 24 * 60 * 60 * 1000 } }),
 *   ],
 * });
 * ```
 */
export function replay(options?: ReplayOptions | false): ReplayPrimitive {
  if (options === false) {
    return {
      __wskit: 'replay',
      __kind: 'infrastructure',
      __identity: [REPLAY_KEY],
      __requires: {},
      options: {},
      disabled: true,
    };
  }

  const opts = options ?? {};
  if (opts.retention) {
    assertOptionalPositiveInteger(opts.retention.maxAgeMs, 'retention.maxAgeMs', 'replay()');
    assertOptionalPositiveInteger(opts.retention.maxMessages, 'retention.maxMessages', 'replay()');
  }
  if (opts.durability !== undefined) {
    assertOneOf(opts.durability, ['strict', 'best-effort'] as const, {
      field: 'durability',
      context: 'replay()',
    });
  }
  if (opts.type !== undefined) {
    assertOneOf(opts.type, ['history', 'snapshot'] as const, {
      field: 'type',
      context: 'replay()',
    });
  }

  return {
    __wskit: 'replay',
    __kind: 'infrastructure',
    __identity: [REPLAY_KEY],
    __requires: { storage: true },
    options: opts,
    __setup(engine) {
      engine.setReplayEnabled(true);

      const { channelKey } = engine.getScopeInfo();
      const exclude = new Set(opts.exclude ?? []);

      engine.onBootSchema(() => {
        ensureReplaySchema(engine.requireStorage().sql);
      });
      engine.onBoot(() => {
        pruneExpiredReplayRows(engine.requireStorage().sql, opts.retention, Date.now());
      });

      const installer = new ReplayInstaller({ engine, channelKey, exclude, opts });

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

      engine.onProtocolMessage('__replay__', installer.protocolHandler);
    },
  };
}

interface ReplayInstallerOptions {
  engine: EngineAccess;

  channelKey: string | undefined;

  exclude: Set<string>;

  opts: ReplayOptions;
}

/**
 * Bundles the context extender, persist callback, and `__replay__` protocol
 * handler used during replay setup. Using a class lets the three callbacks
 * share the same engine reference, channel key, exclude set, and options
 * without repeating the constructor arguments.
 *
 * @internal
 */
class ReplayInstaller {
  private readonly engine: EngineAccess;
  private readonly channelKey: string | undefined;
  private readonly exclude: Set<string>;
  private readonly opts: ReplayOptions;

  constructor({ engine, channelKey, exclude, opts }: ReplayInstallerOptions) {
    this.engine = engine;
    this.channelKey = channelKey;
    this.exclude = exclude;
    this.opts = opts;
  }

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
        this.engine.assertReplaySendContract(event, payload, {
          channel: scope.channelName ?? undefined,
          channelScope: scope.channelScope ?? null,
        });
        this.engine.sendReplay(base.id as string, {
          channelName: scope.channelName ?? null,
          channelScope: scope.channelScope ?? null,
          event,
          payload,
          wire,
        });
      };

      return {};
    }

    if (!base.id) return {};

    // Top-level replay cascades into every channel it has not ceded to a
    // channel-scoped instance. When the live ctx is in such a channel scope,
    // attach `ctx.channel.sendReplay` so handlers can replay channel frames
    // through the cascading store, mirroring the storage cascade.
    if (scope.channelName || scope.channelScope) {
      if (
        !base.channel ||
        !matchesReplayScope(undefined, scope, this.engine.getReplayClaimedChannelKeys())
      ) {
        return {};
      }
      base.channel.sendReplay = (event: string, payload: unknown, wire: ReplayWire) => {
        this.engine.assertReplaySendContract(event, payload, {
          channel: scope.channelName ?? undefined,
          channelScope: scope.channelScope ?? null,
        });
        this.engine.sendReplay(base.id as string, {
          channelName: scope.channelName ?? null,
          channelScope: scope.channelScope ?? null,
          event,
          payload,
          wire,
        });
      };
      return {};
    }

    base.sendReplay = (event: string, payload: unknown, wire: ReplayWire) => {
      this.engine.assertReplaySendContract(event, payload, {
        channel: wire.channel,
        channelScope: wire.channelScope,
      });
      this.engine.sendReplay(base.id as string, {
        channelName: wire.channel ?? null,
        channelScope: wire.channelScope ?? null,
        event,
        payload,
        wire,
      });
    };

    return {};
  };

  /** Persist one outgoing wire message to the replay table. */
  persist = (wireMessage: WireOutgoingMessage): void => {
    if (
      !shouldStoreReplayMessage(wireMessage.event, {
        channelKey: this.channelKey,
        wskit: wireMessage.wskit,
        exclude: this.exclude,
        claimedChannelKeys: this.engine.getReplayClaimedChannelKeys(),
      })
    )
      return;

    const { sql } = this.engine.requireStorage();
    const scope = this.engine.getInvocationScope();
    // `replayScope` carries this frame's channel markers. For the row-count
    // limit, `channel`/`channelScope` pick the store: there are two replay
    // stores (top-level and per-channel). `pruneReplayScopeRows` keys on
    // channel only.
    const replayScope = readReplayScope(wireMessage.wskit);
    const retention = this.opts.retention;

    function runPrune(sqlForPrune: Pick<SQLProvider, 'exec'>): void {
      pruneExpiredReplayRows(sqlForPrune, retention, Date.now());
      pruneReplayScopeRows(sqlForPrune, retention, replayScope);
    }

    const row = persistReplayMessage(sql, {
      options: this.opts,
      event: wireMessage.event,
      payload: wireMessage.payload,
      wskit: wireMessage.wskit,
      now: Date.now(),
      scope,
      postFlush: runPrune,
      // A reducer can return any { event, payload }; the live send only checked
      // the original frame. Validate the reduced value here so the stored row
      // conforms to the contract and the replay-from-storage path stays trusted.
      validateReduced: this.opts.reduce
        ? (event, payload) =>
            this.engine.assertReplaySendContract(event, payload, {
              channel: replayScope.channel ?? undefined,
              channelScope: replayScope.channelScope,
            })
        : undefined,
    });

    // Only snapshot writes that ran inside an open handler scope get queued
    // for a later flush. Every other case (history mode, or snapshot mode
    // with no handler scope) has already saved the row to SQL above, so the
    // retention prune needs to run here and now — otherwise the table can
    // grow past its row limit before the next call cleans it up.
    //
    // For the queued case the scope flusher calls `runPrune` itself once
    // the row is actually on disk, so we deliberately skip the prune here.
    const queued = scope !== null && (this.opts.type ?? 'history') === 'snapshot';
    if (!queued) {
      pruneExpiredReplayRows(sql, retention, row?.createdAt ?? Date.now());
      pruneReplayScopeRows(sql, retention, replayScope);
    }
  };

  /** Handle the `__replay__` protocol frame by resending stored rows to the requester. */
  protocolHandler = async (
    ctx: unknown,
    frame: Protocol.IncomingProtocolFrame,
  ): Promise<boolean> => {
    if (frame.event !== '__replay__') return false;

    const scope = readReplayContextScope(ctx as Record<PropertyKey, unknown>);
    if (!matchesReplayScope(this.channelKey, scope, this.engine.getReplayClaimedChannelKeys())) {
      return false;
    }

    const connection = (ctx as Record<PropertyKey, unknown>)[ENGINE_INTERNAL_CONNECTION] as
      | RuntimeConnection
      | undefined;
    if (!isChannelReplayAuthorized(connection, scope, frame.__wskit)) {
      // No rows and no error — don't reveal the channel to a non-member.
      return true;
    }

    const since = frame.payload.lastKnownSeq ?? 0;
    const { sql } = this.engine.requireStorage();
    const rows = loadReplayRows(sql, since, {
      channelName: scope.channelName,
      channelScope: scope.channelScope ?? null,
    });

    const connectionId = String((ctx as Record<PropertyKey, unknown>).id ?? '');
    if (!connectionId) return true;

    for (const row of rows) {
      const rowPayload = JSON.parse(row.payload) as Record<string, unknown>;
      this.engine.sendReplay(connectionId, {
        channelName: row.channel,
        channelScope: row.channelScope,
        event: row.event,
        payload: rowPayload,
        wire: {
          seq: row.seq,
          messageId: row.messageId,
          channel: row.channel ?? undefined,
        },
      });
    }

    return true;
  };
}

/**
 * Symbol key used to reference this primitive in dependency declarations.
 */
replay.__key = REPLAY_KEY;
