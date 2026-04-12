/* oxlint-disable @typescript-eslint/no-explicit-any */
/* oxlint-disable eslint-plugin-import(no-cycle) */
/**
 * Side-effect import that adds `.replayCustom()` to the server and group builders.
 *
 * Import path: `import '@wskit/server/replay/custom'`
 * Adds method: `.replayCustom()`
 *
 * `replayCustom` is the escape hatch from the built-in SQLite replay store. Use
 * it when you want to store messages in your own database, a KV store, or any
 * other backend, while still benefiting from the sequence + dedup stamping that
 * the engine provides.
 *
 * Calling `.replayCustom()` returns a `ReplayCustomBuilder` with:
 *   - `.onBeforeSend(fn)` — called synchronously before each outgoing message
 *     is sent. Use this to persist the message to your own store.
 *   - `.onAfterSend(fn)` — called (optionally async) after each send. Use this
 *     for lower-latency store-after-send patterns.
 *   - `.onReplay(fn)` — called when the client sends `_replay`. Receives the
 *     replay context (with `ctx.sendReplay`) and the `since` sequence number.
 *     Your implementation should re-send all stored messages since `since`.
 *   - `.done()` — finish and return to the parent builder.
 *   - `.extract()` — detach as a reusable `CustomReplayPrimitive`.
 *
 * The `'top'` generic on all types refers to the top-level connection scope
 * (as opposed to a channel scope). Inside a `.channel()` builder the type
 * would be `'channel'`, but that is not currently accessible via the builder API.
 *
 * This file also exports `ReplayCustomBuilder` and uses module augmentation +
 * prototype patching to wire `.replayCustom()` into the existing builders.
 */

import { GroupBuilder, ServerBuilder } from '~/_builder/server-builder.ts';
import { handleReplay as createHandleReplay } from '~/replay/custom.ts';
import type { NextState, ScopeStateShape } from '~/_types/scope-state.ts';
import type { Primitive } from '~/primitive.ts';
import type {
  CustomReplayOptions,
  CustomReplayPrimitive,
  OutgoingWireMessage,
} from '~/replay/custom.ts';

/**
 * A sub-builder returned by `.replayCustom()`. Collects the three lifecycle
 * hooks and pushes a `CustomReplayPrimitive` onto the parent builder when
 * `.done()` is called.
 *
 * `TParent` is the parent builder type returned by `.done()`.
 * `_TState` is the parent's type-level state, kept for future extensions.
 */
export class ReplayCustomBuilder<TParent, _TState extends ScopeStateShape> {
  /** @internal Reference to the parent builder for `.done()`. */
  readonly _parent: TParent;
  /** @internal The parent builder's primitive array for `.done()` to push into. */
  readonly _parentPrimitives: Primitive[];
  /**
   * @internal Accumulated hook functions. Typed as `any` here because the
   * generic scope parameter (`'top'` vs `'channel'`) is resolved only when
   * `.done()` or `.extract()` casts to `CustomReplayOptions<'top'>`.
   */
  _options: { onBeforeSend?: any; onAfterSend?: any; onReplay?: any } = {};

  constructor(parent: TParent, parentPrimitives: Primitive[]) {
    this._parent = parent;
    this._parentPrimitives = parentPrimitives;
  }

  /**
   * Register a synchronous hook that fires just before each outgoing message is
   * sent to the client. Use this to persist the message to your own store in a
   * "store-before-send" pattern (equivalent to `durability: 'strict'` in the
   * built-in replay).
   *
   * The `message` object carries the event name, the clean payload (internal
   * `_seq` / `_messageId` fields are stripped), and a `wire` object with those
   * same sequence and message-ID values for your storage layer.
   */
  onBeforeSend(fn: (message: OutgoingWireMessage<'top'>) => void): this {
    this._options.onBeforeSend = fn;
    return this;
  }

  /**
   * Register an async hook that fires just after each outgoing message is sent.
   * Use this to persist after sending for lower latency ("store-after-send",
   * equivalent to `durability: 'best-effort'` in built-in replay).
   */
  onAfterSend(fn: (message: OutgoingWireMessage<'top'>) => void | Promise<void>): this {
    this._options.onAfterSend = fn;
    return this;
  }

  /**
   * Register the replay handler. Called when the client sends a `_replay`
   * protocol message. The handler receives the replay context (which includes
   * `ctx.sendReplay` to re-send stored messages) and `since` (the sequence
   * number of the last message the client received). Your handler should
   * query your store and call `ctx.sendReplay(event, payload, wire)` for each
   * missed message in order.
   */
  onReplay(fn: CustomReplayOptions<'top'>['onReplay']): this {
    this._options.onReplay = fn;
    return this;
  }

  /**
   * Finish building the custom replay handler. Pushes the configured
   * `CustomReplayPrimitive` onto the parent builder and returns the parent.
   */
  done(): TParent {
    this._parentPrimitives.push(
      createHandleReplay(this._options as CustomReplayOptions<'top'>) as unknown as Primitive,
    );
    return this._parent;
  }

  /**
   * Package the configured hooks into a standalone `CustomReplayPrimitive`
   * without pushing it onto the parent builder. Register it elsewhere with
   * `.use()`.
   */
  extract(): CustomReplayPrimitive<'top'> {
    return createHandleReplay(
      this._options as CustomReplayOptions<'top'>,
    ) as CustomReplayPrimitive<'top'>;
  }
}

/**
 * Module augmentation: adds `.replayCustom()` to the builder interfaces so
 * TypeScript recognises the method after this file is imported.
 */
declare module '~/_builder/server-builder.ts' {
  interface ServerBuilder<TState extends ScopeStateShape> {
    /**
     * Open a custom replay sub-builder. Attach `.onBeforeSend()` and/or
     * `.onAfterSend()` to store messages, and `.onReplay()` to re-send them
     * on reconnect. Finish with `.done()`.
     */
    replayCustom(): ReplayCustomBuilder<
      ServerBuilder<NextState<TState, CustomReplayPrimitive<'top'>>>,
      TState
    >;
  }

  interface GroupBuilder<TState extends ScopeStateShape> {
    /**
     * Open a custom replay sub-builder. Attach `.onBeforeSend()` and/or
     * `.onAfterSend()` to store messages, and `.onReplay()` to re-send them
     * on reconnect. Finish with `.done()`.
     */
    replayCustom(): ReplayCustomBuilder<
      GroupBuilder<NextState<TState, CustomReplayPrimitive<'top'>>>,
      TState
    >;
  }
}

/** Runtime implementation of `.replayCustom()` for `ServerBuilder`. */
ServerBuilder.prototype.replayCustom = function (this: ServerBuilder<any>) {
  return new ReplayCustomBuilder(this, this._primitives);
};

/** Runtime implementation of `.replayCustom()` for `GroupBuilder`. */
GroupBuilder.prototype.replayCustom = function (this: GroupBuilder<any>) {
  return new ReplayCustomBuilder(this, this._primitives);
};
