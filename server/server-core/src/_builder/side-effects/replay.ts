/* oxlint-disable @typescript-eslint/no-explicit-any */
/**
 * Side-effect import that adds `.replay()` to the server and group builders.
 *
 * Import path: `import '@wskit/server/replay'`
 * Adds method: `.replay(type?)`
 *
 * Replay lets a client that reconnects after a network drop request the
 * messages it missed. The built-in replay implementation stores outgoing
 * messages in SQLite and re-sends them when the client sends a `_replay`
 * protocol message containing the sequence number of the last message it
 * received.
 *
 * Calling `.replay()` returns a `ReplayBuilder` with a fluent API for
 * configuration:
 *   - `.exclude(...events)` — events that should never be replayed
 *   - `.retention(opts)` — max age and/or max message count for stored rows
 *   - `.durability(mode)` — `'strict'` (store before send) or `'best-effort'`
 *   - `.snapshotKey(fn)` — for snapshot mode: computes the deduplication key
 *   - `.reduce(fn)` — for snapshot mode: merges consecutive snapshots
 *   - `.done()` — finish configuration and return to the parent builder
 *   - `.extract()` — detach as a reusable `ReplayPrimitive`
 *
 * Replay depends on the `sequence` and `dedup` primitives (auto-injected) and
 * requires the `storage` platform capability.
 *
 * This file also exports `ReplayBuilder` and uses module augmentation +
 * prototype patching to wire `.replay()` into the existing builders.
 */

import { GroupBuilder, ServerBuilder } from '~/_builder/server-builder.ts';
import { replay as createReplay } from '~/replay/replay.ts';
import type { NextState, ScopeStateShape } from '~/_types/scope-state.ts';
import type { Primitive } from '~/primitive.ts';
import type { ReplayPrimitive } from '~/replay/replay.ts';
import type {
  ReplayOptions,
  ReplayRetention,
  ReplaySnapshotValue,
  ReplayType,
} from '~/replay/types.ts';

/**
 * A sub-builder returned by `.replay()`. Collects replay options and pushes a
 * `ReplayPrimitive` onto the parent builder when `.done()` is called.
 *
 * `TParent` is the parent builder type returned by `.done()`.
 * `_TState` is the parent's type-level state, kept for future extensions.
 */
export class ReplayBuilder<TParent, _TState extends ScopeStateShape> {
  /** @internal Reference to the parent builder for `.done()`. */
  readonly _parent: TParent;
  /** @internal The parent builder's primitive array for `.done()` to push into. */
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
   * - `'strict'` (default) — writes to SQLite *before* the WebSocket send
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
   */
  snapshotKey(fn: (event: string, payload: Record<string, unknown>) => string): this {
    this._options = { ...this._options, snapshotKey: fn };
    return this;
  }

  /**
   * For `'snapshot'` replay mode only: merge consecutive snapshots instead of
   * replacing them. Receives the currently stored snapshot (or `null`) and the
   * incoming event. Return the value to store, or `null` to delete the snapshot.
   */
  reduce(
    fn: (
      previous: ReplaySnapshotValue | null,
      next: ReplaySnapshotValue,
    ) => ReplaySnapshotValue | null,
  ): this {
    this._options = { ...this._options, reduce: fn };
    return this;
  }

  /**
   * Finish replay configuration. Pushes the configured `ReplayPrimitive` onto
   * the parent builder and returns the parent so the fluent chain can continue.
   */
  done(): TParent {
    this._parentPrimitives.push(createReplay(this._options) as unknown as Primitive);
    return this._parent;
  }

  /**
   * Package the configured options into a standalone `ReplayPrimitive` without
   * pushing it onto the parent builder. Register it elsewhere with `.use()`.
   */
  extract(): ReplayPrimitive {
    return createReplay(this._options) as ReplayPrimitive;
  }
}

/**
 * Module augmentation: adds `.replay()` to the builder interfaces so TypeScript
 * recognises the method after this file is imported.
 */
declare module '~/_builder/server-builder.ts' {
  interface ServerBuilder<TState extends ScopeStateShape> {
    /**
     * Open a replay sub-builder. Configure options with `.exclude()`,
     * `.retention()`, `.durability()`, etc., then call `.done()`.
     *
     * @param type  `'history'` (default) keeps all messages; `'snapshot'` keeps
     *   only the latest value per logical key.
     */
    replay(
      type?: ReplayType,
    ): ReplayBuilder<ServerBuilder<NextState<TState, ReplayPrimitive>>, TState>;
  }

  interface GroupBuilder<TState extends ScopeStateShape> {
    /**
     * Open a replay sub-builder. Configure options with `.exclude()`,
     * `.retention()`, `.durability()`, etc., then call `.done()`.
     *
     * @param type  `'history'` (default) keeps all messages; `'snapshot'` keeps
     *   only the latest value per logical key.
     */
    replay(
      type?: ReplayType,
    ): ReplayBuilder<GroupBuilder<NextState<TState, ReplayPrimitive>>, TState>;
  }
}

/** Runtime implementation of `.replay()` for `ServerBuilder`. */
ServerBuilder.prototype.replay = function (this: ServerBuilder<any>, type?: ReplayType) {
  return new ReplayBuilder(this, this._primitives, type);
};

/** Runtime implementation of `.replay()` for `GroupBuilder`. */
GroupBuilder.prototype.replay = function (this: GroupBuilder<any>, type?: ReplayType) {
  return new ReplayBuilder(this, this._primitives, type);
};
