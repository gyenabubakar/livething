import { CAPABILITY_KIND } from '~/_define/capability-kinds.ts';
import { capability, hostCapability, stampKind, withCapabilityKind } from '~/_define/capability.ts';
import { handleReplay } from '~/replay/custom/custom.ts';
import { replay as replayFactory } from '~/replay/replay.ts';
import type { Capability, HostCapability } from '~/_define/capability.ts';
import type { Primitive } from '~/primitive.ts';
import type { CustomReplayOptions } from '~/replay/custom/custom.ts';
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
 * calls `ctx.sendReplay(...)`; `beforeSend` / `afterSend` (optional) write each
 * outgoing message into your store.
 */
export interface CustomReplayHooks {
  /** Store a message before it is sent (strict durability). */
  readonly beforeSend?: CustomReplayOptions<'top'>['onBeforeSend'];
  /** Store a message after it is sent (best-effort durability). */
  readonly afterSend?: CustomReplayOptions<'top'>['onAfterSend'];
  /** Resend stored messages newer than `since` on reconnect. Required. */
  readonly replay: CustomReplayOptions<'top'>['onReplay'];
}

/** A `replay.custom()` capability, carrying the builder that turns hooks into a primitive. */
export interface ReplayCustomCapability extends Capability<{}, never, 'replay-custom'> {
  /** Host-owned: rejected inside a plugin's `define({ scope: 'plugin' })`. @internal */
  readonly __hostOnly: true;
  /** Build the custom-replay primitive from `base.replay(...)` hooks. @internal */
  readonly __buildCustomReplay: (hooks: CustomReplayHooks) => Primitive;
}

/**
 * Record outgoing messages and resend the missing tail when a client reconnects,
 * with no handler code. History mode keeps every message. Requires the `dedup()`
 * and `sequence({ persist: true })` capabilities (and storage) — the build fails
 * without them.
 *
 * @example
 * ```ts
 * import { define } from '@wskit/server';
 * import { replay } from '@wskit/server/replay';
 * import { dedup } from '@wskit/server/dedup';
 * import { sequence } from '@wskit/server/sequence';
 *
 * const base = define({
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
 * optional `beforeSend` / `afterSend`). Unlike built-in replay, custom replay
 * does not require `dedup` or `sequence`.
 *
 * @example
 * ```ts
 * import { define } from '@wskit/server';
 * import { replay } from '@wskit/server/replay';
 *
 * const base = define({ capabilities: [replay.custom()] });
 *
 * base.replay({
 *   beforeSend(ctx, msg) {
 *     ctx.sql.exec('INSERT INTO log (seq, event) VALUES (?, ?)', msg.wire.seq, msg.event);
 *   },
 *   replay(ctx, since) {
 *     for (const row of loadRows(ctx.sql, since)) ctx.sendReplay(row.event, row.payload, row.wire);
 *   },
 * });
 * ```
 */
const custom = withCapabilityKind(function custom(): ReplayCustomCapability {
  const cap = capability<{}, never, 'replay-custom'>([]) as ReplayCustomCapability;
  (cap as { __hostOnly: true }).__hostOnly = true;
  (cap as { __buildCustomReplay: (hooks: CustomReplayHooks) => Primitive }).__buildCustomReplay = (
    hooks,
  ) =>
    handleReplay({
      onBeforeSend: hooks.beforeSend,
      onAfterSend: hooks.afterSend,
      onReplay: hooks.replay,
    });
  return stampKind(cap, CAPABILITY_KIND.replayCustom);
}, CAPABILITY_KIND.replayCustom);

/**
 * Replay capabilities. List `replay.history(...)` or `replay.snapshot(...)` for
 * built-in replay, or `replay.custom()` to enable a `base.replay({ ... })` hook
 * with your own storage. The two are mutually exclusive at the same scope.
 */
export const replay = { history, snapshot, custom };
