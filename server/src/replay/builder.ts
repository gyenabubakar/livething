import { replay as createReplay } from '~/replay/replay.ts';
import type { ScopeStateShape } from '~/_types/scope-state';
import type { Primitive } from '~/primitive.ts';
import type { ReplayPrimitive } from '~/replay/replay.ts';
import type {
  ReplayOptions,
  ReplayRetention,
  ReplaySnapshotValue,
  ReplayType,
} from '~/replay/types.ts';

/**
 * Fluent builder for configuring built-in message replay. Replay stores
 * outgoing messages and re-sends them to clients that reconnect with a `since`
 * sequence number. You can configure snapshot mode, retention limits, and
 * durability.
 */
export class ReplayBuilder<
  TParent,
  _TState extends ScopeStateShape,
  _TMode extends ReplayType = 'history',
> {
  /** @internal Reference to the parent builder for `_seal()`. */
  readonly _parent: TParent;
  /** @internal The parent builder's primitive array for `_seal()` to push into. */
  readonly _parentPrimitives: Primitive[];
  /** @internal Accumulated replay options. Spread-updated to stay immutable between calls. */
  _options: ReplayOptions = {};

  constructor(parent: TParent, parentPrimitives: Primitive[], type?: ReplayType) {
    this._parent = parent;
    this._parentPrimitives = parentPrimitives;
    if (type) this._options = { ...this._options, type };
  }

  /**
   * Events listed here will be sent normally but will never be stored for
   * replay. Useful for high-frequency ephemeral events (e.g. cursor positions)
   * that have no value to replay after a reconnect.
   */
  exclude(...events: string[]): this {
    this._options = { ...this._options, exclude: events };
    return this;
  }

  /**
   * Limit how long and how many rows the replay store keeps per scope.
   * Rows that exceed `maxAgeMs` or push the count above `maxMessages` are
   * pruned during the next store or boot operation.
   */
  retention(retention: ReplayRetention): this {
    this._options = { ...this._options, retention };
    return this;
  }

  /**
   * Control when messages are persisted relative to when they are sent.
   *
   * - `'strict'` (default) — persists to the replay store *before* the WebSocket send
   *   completes, guaranteeing no message is sent without being stored first.
   * - `'best-effort'` — sends first and stores asynchronously, reducing
   *   latency at the cost of a small window where a sent message might not
   *   be replayed if the server crashes immediately after.
   */
  durability(durability: 'strict' | 'best-effort'): this {
    this._options = { ...this._options, durability };
    return this;
  }

  /**
   * For `'snapshot'` replay mode only: compute a stable key from an outgoing
   * event. Two messages with the same key replace each other in the store, so
   * replay sends only the most recent snapshot for that key.
   *
   * If omitted, the event name is used as the key.
   *
   * Calling this method in history mode is a type error and throws at build time.
   */
  snapshotKey(
    this: ReplayBuilder<TParent, _TState, 'snapshot'>,
    fn: (event: string, payload: Record<string, unknown>) => string,
  ): ReplayBuilder<TParent, _TState, 'snapshot'> {
    this._options = { ...this._options, snapshotKey: fn };
    return this;
  }

  /**
   * For `'snapshot'` replay mode only: merge consecutive snapshots instead of
   * replacing them. Receives the currently stored snapshot (or `null`) and the
   * incoming event. Return the value to store, or `null` to delete the snapshot.
   *
   * Calling this method in history mode is a type error and throws at build time.
   */
  reduce(
    this: ReplayBuilder<TParent, _TState, 'snapshot'>,
    fn: (
      previous: ReplaySnapshotValue | null,
      next: ReplaySnapshotValue,
    ) => ReplaySnapshotValue | null,
  ): ReplayBuilder<TParent, _TState, 'snapshot'> {
    this._options = { ...this._options, reduce: fn };
    return this;
  }

  /** @internal Throw if snapshot-only options are set without `'snapshot'` mode. */
  private _guardSnapshotOnlyOptions(): void {
    if ((this._options.type ?? 'history') === 'snapshot') return;

    const offending = this._options.snapshotKey
      ? 'snapshotKey'
      : this._options.reduce
        ? 'reduce'
        : null;

    if (!offending) return;

    throw new Error(
      `Replay: \`snapshotKey\` and \`reduce\` only apply when mode is 'snapshot'. Call \`.replay('snapshot', ...)\` instead of \`.replay(...)\` to enable these options, or remove them. (offending option: \`${offending}\`)`,
    );
  }

  /** @internal Seal the replay config and push it onto the parent's primitive list. */
  _seal(): void {
    this._guardSnapshotOnlyOptions();
    this._parentPrimitives.push(createReplay(this._options) as unknown as Primitive);
  }

  /**
   * Package the configured options into a standalone `ReplayPrimitive` without
   * pushing it onto the parent builder. Register it elsewhere with `.use()`.
   */
  extract(): ReplayPrimitive {
    this._guardSnapshotOnlyOptions();
    return createReplay(this._options) as ReplayPrimitive;
  }
}
