import { handleReplay as createHandleReplay } from '~/replay/custom/custom.ts';
import type { ScopeStateShape } from '~/_types/scope-state.ts';
import type { Primitive } from '~/primitive.ts';
import type {
  CustomReplayOptions,
  CustomReplayPrimitive,
  CustomReplaySendContext,
  OutgoingWireMessage,
} from '~/replay/custom/custom.ts';

export class ReplayCustomBuilder<TParent, _TState extends ScopeStateShape> {
  /** @internal Reference to the parent builder for `_seal()`. */
  readonly _parent: TParent;
  /** @internal The parent builder's primitive array for `_seal()` to push into. */
  readonly _parentPrimitives: Primitive[];
  /**
   * @internal Accumulated hook functions. Typed as `any` here because the
   * generic scope parameter (`'top'` vs `'channel'`) is resolved only when
   * `_seal()` or `.extract()` casts to `CustomReplayOptions<'top'>`.
   */
  _options: { -readonly [K in keyof CustomReplayOptions<'top'>]?: CustomReplayOptions<'top'>[K] } =
    {};

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
  onBeforeSend(
    fn: (ctx: CustomReplaySendContext, message: OutgoingWireMessage<'top'>) => void,
  ): this {
    this._options.onBeforeSend = fn;
    return this;
  }

  /**
   * Register an async hook that fires just after each outgoing message is sent.
   * Use this to persist after sending for lower latency ("store-after-send",
   * equivalent to `durability: 'best-effort'` in built-in replay).
   */
  onAfterSend(
    fn: (ctx: CustomReplaySendContext, message: OutgoingWireMessage<'top'>) => void | Promise<void>,
  ): this {
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

  /** @internal Seal the custom replay and push it onto the parent's primitive list. */
  _seal(): void {
    this._parentPrimitives.push(
      createHandleReplay(this._options as CustomReplayOptions<'top'>) as unknown as Primitive,
    );
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
