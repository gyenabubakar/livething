import { CAPABILITY_KIND } from '~/_define/capability-kinds.ts';
import { capability, hostCapability, stampKind, withCapabilityKind } from '~/_define/capability.ts';
import { customReplaySend, handleReplay } from '~/replay/custom/custom.ts';
import { replay as replayFactory } from '~/replay/replay.ts';
import type { Capability, HostCapability } from '~/_define/capability.ts';
import type { Primitive } from '~/primitive.ts';
import type { CustomReplayOptions, CustomReplayScope } from '~/replay/custom/custom.ts';
import type { ReplayOptions } from '~/replay/types.ts';

export type { ReplaySnapshotValue, SnapshotReducer, SnapshotKeyFn } from '~/replay/types.ts';

/** Built-in history-mode replay settings — every replayable message is kept as its own row. */
export type HistoryConfig = Pick<ReplayOptions, 'durability' | 'retention' | 'exclude'>;

/** Built-in snapshot-mode replay settings — only the latest row per logical key is kept. */
export type SnapshotConfig = Pick<
  ReplayOptions,
  'durability' | 'retention' | 'exclude' | 'snapshotKey' | 'reduce'
>;

/**
 * The hooks you pass to `base.replay({ ... })`. You own the storage and the
 * resend: `replay` (the resend, required) reads your store on reconnect and
 * calls `ctx.sendReplay(...)`; `beforeBroadcast` / `afterBroadcast` (optional)
 * write each broadcast into your store.
 *
 * `beforeBroadcast` / `afterBroadcast` follow the same recording rule as built-in replay.
 * Each runs once per broadcast, even when no connection receives it live:
 *
 * - `ctx.broadcast` and `ctx.channel.broadcast` arrive with `msg.userId` set
 *   to `null`: replay them to anyone who may read that scope.
 * - `ctx.user.broadcast`, `ctx.users.get(id).broadcast` and
 *   `ctx.channel.broadcastTo(userRef, ...)` arrive with `msg.userId` set to
 *   that user: replay them only when the `replay` hook's `ctx.userId` is the
 *   same id.
 * - `ctx.send`, `ctx.connections.get(ref).send`, `ctx.channel.send`,
 *   `ctx.channel.broadcastTo` a connection, tag or group, and tag broadcasts
 *   never arrive. A reconnect opens a new connection with a new id, so no later
 *   connection could prove it was the one addressed.
 */
export interface CustomReplayHooks {
  /**
   * Store a broadcast before any recipient is sent it (strict durability). If
   * it throws, no recipient receives the broadcast.
   */
  readonly beforeBroadcast?: CustomReplayOptions<'top'>['onBeforeBroadcast'];
  /**
   * Store a broadcast after every recipient was sent it (best-effort
   * durability). A throw or rejection is logged and never affects delivery.
   */
  readonly afterBroadcast?: CustomReplayOptions<'top'>['onAfterBroadcast'];
  /**
   * Resend the stored messages newer than `since` that `ctx.userId` may see.
   * Runs when a client reconnects. Required.
   */
  readonly replay: CustomReplayOptions<'top'>['onReplay'];
}

/**
 * The hooks you pass to a channel's `channel.replay({ ... })`. The same three
 * hooks as {@link CustomReplayHooks}, with the same recording rule, scoped to
 * that one channel: every message has a `msg.wire.channel` string, and the
 * `replay` ctx carries `ctx.channel.name` instead of `ctx.request`.
 */
export interface ChannelCustomReplayHooks {
  /**
   * Store a channel broadcast before any member is sent it (strict
   * durability). If it throws, no member receives the broadcast.
   */
  readonly beforeBroadcast?: CustomReplayOptions<'channel'>['onBeforeBroadcast'];
  /**
   * Store a channel broadcast after every member was sent it (best-effort
   * durability). A throw or rejection is logged and never affects delivery.
   */
  readonly afterBroadcast?: CustomReplayOptions<'channel'>['onAfterBroadcast'];
  /** Resend this channel's stored messages newer than `since` on reconnect. Required. */
  readonly replay: CustomReplayOptions<'channel'>['onReplay'];
}

/** A `replay.custom()` capability, carrying the builder that turns hooks into a primitive. */
export interface ReplayCustomCapability extends Capability<{}, never, 'replay-custom'> {
  /** Host-owned: rejected inside a plugin's `server({ scope: 'plugin' })`. @internal */
  readonly __hostOnly: true;
  /** Build the custom-replay primitive from `base.replay(...)` or `channel.replay(...)` hooks. @internal */
  readonly __buildCustomReplay: (hooks: CustomReplayHooks | ChannelCustomReplayHooks) => Primitive;
}

/**
 * Record outgoing messages and resend the missing tail when a client reconnects,
 * with no handler code. History mode keeps every message. Requires the `dedup()`
 * and `sequence({ persist: true })` capabilities (and storage) — the build fails
 * without them.
 *
 * @example
 * ```ts
 * import { server } from '@livething/server';
 * import { replay } from '@livething/server/replay';
 * import { dedup } from '@livething/server/dedup';
 * import { sequence } from '@livething/server/sequence';
 *
 * const base = server({
 *   capabilities: [
 *     dedup(),
 *     sequence({ persist: true }),
 *     replay.history({ retention: { maxAgeMs: 60_000 } }),
 *   ],
 * });
 * ```
 */
const history = withCapabilityKind(function history(
  config?: HistoryConfig,
): HostCapability<{}, 'replay'> {
  const cap = hostCapability<{}, 'replay'>(
    [replayFactory({ ...config, type: 'history' })],
    ['replay'],
  );
  attachBuiltinReplayBuilder(cap);
  return stampKind(cap, CAPABILITY_KIND.replay);
}, CAPABILITY_KIND.replay);

/**
 * Record outgoing messages and resend the latest state per key on reconnect.
 * Snapshot mode keeps only the most recent message for each `snapshotKey`. Same
 * requirements as {@link history}: `dedup()` and `sequence({ persist: true })`.
 *
 * @example
 * ```ts
 * replay.snapshot({ snapshotKey: (event, payload) => String(payload.roomId) });
 * ```
 */
const snapshot = withCapabilityKind(function snapshot(
  config?: SnapshotConfig,
): HostCapability<{}, 'replay'> {
  const cap = hostCapability<{}, 'replay'>(
    [replayFactory({ ...config, type: 'snapshot' })],
    ['replay'],
  );
  attachBuiltinReplayBuilder(cap);
  return stampKind(cap, CAPABILITY_KIND.replay);
}, CAPABILITY_KIND.replay);

/**
 * Stamp a built-in replay capability with the builder a channel borrows to
 * forward its own `replay: true | false | ReplayOptions` config. Lets the
 * channel module honour per-channel replay without value-importing the replay
 * engine itself.
 */
function attachBuiltinReplayBuilder(cap: HostCapability<{}, 'replay'>): void {
  (cap as { __buildBuiltinReplay?: (replayConfig: unknown) => Primitive }).__buildBuiltinReplay = (
    replayConfig,
  ) => {
    if (replayConfig === false) return replayFactory(false);

    if (replayConfig === true) return replayFactory();

    return replayFactory(replayConfig as ReplayOptions);
  };
}

/**
 * Enable custom replay, where you own the storage and the resend. Listing this
 * lets you register `base.replay({ ... })` with your own `replay` hook (and
 * optional `beforeBroadcast` / `afterBroadcast`), and gives handlers
 * `ctx.sendReplay()` and `ctx.channel.sendReplay()` to resend a stored message
 * to the calling connection (e.g. to answer a "load older history" request).
 *
 * Like built-in replay, it requires the `dedup()` and
 * `sequence({ persist: true })` capabilities, and the build fails without them.
 * `dedup()` stamps `msg.wire.messageId` and `sequence()` stamps
 * `msg.wire.deliverySeq`, the cursor your `replay` hook compares with `since`.
 * The sequence must persist so a stored `deliverySeq` stays valid after a
 * restart.
 *
 * `beforeBroadcast` / `afterBroadcast` see each broadcast once, with
 * `msg.userId` telling you who may replay it (see {@link CustomReplayHooks});
 * the `replay` hook gets the requester's `ctx.userId` to filter by.
 *
 * @example
 * ```ts
 * import { server } from '@livething/server';
 * import { dedup } from '@livething/server/dedup';
 * import { replay } from '@livething/server/replay';
 * import { sequence } from '@livething/server/sequence';
 *
 * interface LogRow {
 *   seq: number;
 *   messageId: string;
 *   event: string;
 *   payload: string;
 * }
 *
 * const base = server({
 *   capabilities: [dedup(), sequence({ persist: true }), replay.custom()],
 * });
 *
 * base.replay({
 *   beforeBroadcast(ctx, msg) {
 *     ctx.sql.exec(
 *       'INSERT INTO log (seq, messageId, event, payload, channel, userId) VALUES (?, ?, ?, ?, ?, ?)',
 *       msg.wire.deliverySeq,
 *       msg.wire.messageId,
 *       msg.event,
 *       JSON.stringify(msg.payload),
 *       msg.wire.channel,
 *       msg.userId,
 *     );
 *   },
 *   replay(ctx, since) {
 *     const rows = ctx.sql
 *       .exec<LogRow>(
 *         'SELECT seq, messageId, event, payload FROM log ' +
 *           'WHERE seq > ? AND channel IS NULL AND (userId IS NULL OR userId = ?) ORDER BY seq',
 *         since,
 *         ctx.userId,
 *       )
 *       .toArray();
 *     for (const row of rows) {
 *       ctx.sendReplay(row.event, JSON.parse(row.payload), {
 *         deliverySeq: row.seq,
 *         messageId: row.messageId,
 *       });
 *     }
 *   },
 * });
 * ```
 */
const custom = withCapabilityKind(function custom(): ReplayCustomCapability {
  const cap = capability<{}, never, 'replay-custom'>([
    customReplaySend(),
  ]) as ReplayCustomCapability;
  (cap as { __hostOnly: true }).__hostOnly = true;
  (
    cap as { __buildCustomReplay: ReplayCustomCapability['__buildCustomReplay'] }
  ).__buildCustomReplay = (hooks) =>
    handleReplay({
      onBeforeBroadcast: hooks.beforeBroadcast,
      onAfterBroadcast: hooks.afterBroadcast,
      onReplay: hooks.replay,
    } as CustomReplayOptions<CustomReplayScope>);
  return stampKind(cap, CAPABILITY_KIND.replayCustom);
}, CAPABILITY_KIND.replayCustom);

/**
 * Replay capabilities. List `replay.history(...)` or `replay.snapshot(...)` for
 * built-in replay, or `replay.custom()` to enable a `base.replay({ ... })` hook
 * with your own storage. The two are mutually exclusive at the same scope.
 */
export const replay = { history, snapshot, custom };
