import { CAPABILITY_KIND } from '~/_define/capability-kinds.ts';
import { hostCapability, stampKind, withCapabilityKind } from '~/_define/capability.ts';
import { replay as replayFactory } from '~/replay/replay.ts';
import type { HostCapability } from '~/_define/capability.ts';
import type { Primitive } from '~/primitive.ts';
import type { ReplayOptions } from '~/replay/types.ts';

export type { ReplaySnapshotValue, SnapshotReducer, SnapshotKeyFn } from '~/replay/types.ts';

/** History-mode replay settings — every replayable message is kept as its own row. */
export type HistoryConfig = Pick<ReplayOptions, 'durability' | 'retention' | 'exclude'>;

/** Snapshot-mode replay settings — only the latest row per logical key is kept. */
export type SnapshotConfig = Pick<
  ReplayOptions,
  'durability' | 'retention' | 'exclude' | 'snapshotKey' | 'reduce'
>;

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
  const cap = hostCapability<{}, 'replay'>([replayFactory({ ...config, type: 'history' })]);
  attachReplayBuilder(cap);
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
  const cap = hostCapability<{}, 'replay'>([replayFactory({ ...config, type: 'snapshot' })]);
  attachReplayBuilder(cap);
  return stampKind(cap, CAPABILITY_KIND.replay);
}, CAPABILITY_KIND.replay);

/**
 * Stamp a replay capability with the builder a channel borrows to
 * forward its own `replay: true | false | ReplayOptions` config. Lets the
 * channel module honour per-channel replay without value-importing the replay
 * engine itself.
 */
function attachReplayBuilder(cap: HostCapability<{}, 'replay'>): void {
  (cap as { __buildReplay?: (replayConfig: unknown) => Primitive }).__buildReplay = (
    replayConfig,
  ) => {
    if (replayConfig === false) return replayFactory(false);

    if (replayConfig === true) return replayFactory();

    return replayFactory(replayConfig as ReplayOptions);
  };
}

/**
 * Replay capabilities. List `replay.history(...)` or `replay.snapshot(...)` to
 * store messages and resend the ones a client missed when it reconnects.
 */
export const replay = { history, snapshot };
