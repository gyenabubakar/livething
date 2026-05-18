/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { Contract } from '~/_api/contract-types.ts';
import type { ChannelCtx } from '~/_api/ctx-types.ts';
import type { CustomReplayOptions } from '~/replay/custom/custom.ts';

// Reads one slot (incoming / requests / streams / etc.) off a sub-contract
// so the .on() / .request() / .stream() methods below get per-event types.
export type FieldOf<T, K extends string> = T extends Record<K, infer V> ? V : Record<string, any>;

// Everything a channel sub-implementer collects, ready to be compiled.
export interface ChannelHandlerBag {
  incomingHandlers: Map<string, (ctx: any, payload: any) => void | Promise<void>>;
  requestHandlers: Map<string, (ctx: any, payload: any) => any>;
  streamGenerators: Map<string, (ctx: any, payload: any) => AsyncGenerator<any, void, unknown>>;
  onBeforeSubscribeHandler?: (ctx: any, data?: any) => void | Promise<void>;
  onSubscribeHandler?: (ctx: any) => void | Promise<void>;
  onUnsubscribeHandler?: (ctx: any) => void | Promise<void>;
  onSessionEndHandler?: (ctx: any) => void | Promise<void>;
  preIntercept?: (ctx: any, message: { event: string; payload: unknown }) => any;
  postIntercepts: Map<string, (ctx: any, payload: any) => any>;
  customReplayHooks?: CustomReplayOptions<'channel'>;
}

/**
 * The builder you get inside `implement(c).channel(name, ch => ...)`. Use it
 * to attach handlers, lifecycle hooks, intercepts, and a custom replay
 * strategy that only apply inside this channel.
 */
export class ChannelImplement<C extends Contract, ChC = any> {
  /** @internal */
  readonly _bag: ChannelHandlerBag = {
    incomingHandlers: new Map(),
    requestHandlers: new Map(),
    streamGenerators: new Map(),
    postIntercepts: new Map(),
  };

  /**
   * Attach a handler for one client→server event declared on this channel.
   * Runs each time a subscribed client sends that event into the channel.
   * `ctx.channel.send` / `.broadcast` are scoped to this channel.
   */
  on<E extends keyof FieldOf<ChC, 'incoming'> & string>(
    event: E,
    handler: (
      ctx: ChannelCtx<ChC, C>,
      payload: FieldOf<ChC, 'incoming'>[E],
    ) => void | Promise<void>,
  ): this {
    this._bag.incomingHandlers.set(event, handler as any);
    return this;
  }

  /**
   * Attach a request/response handler scoped to this channel. Return a value
   * or call `ctx.respond(value)`.
   */
  request<E extends keyof FieldOf<ChC, 'requests'> & string>(
    event: E,
    handler: (
      ctx: ChannelCtx<ChC, C> & {
        respond(value: FieldOf<ChC, 'requests'>[E] extends { response: infer R } ? R : void): void;
      },
      payload: FieldOf<ChC, 'requests'>[E] extends { payload: infer P } ? P : never,
    ) =>
      | (FieldOf<ChC, 'requests'>[E] extends { response: infer R } ? R : void)
      | void
      | Promise<(FieldOf<ChC, 'requests'>[E] extends { response: infer R } ? R : void) | void>,
  ): this {
    this._bag.requestHandlers.set(event, handler as any);
    return this;
  }

  /** Attach the generator for a server-pushed stream scoped to this channel. */
  stream<E extends keyof FieldOf<ChC, 'streams'> & string>(
    event: E,
    generator: (
      ctx: ChannelCtx<ChC, C> & {
        nudges(v: unknown): readonly { event: string; payload: unknown }[];
      },
      payload: FieldOf<ChC, 'streams'>[E] extends { payload: infer P } ? P : never,
    ) => AsyncGenerator<
      FieldOf<ChC, 'streams'>[E] extends { chunk: infer Ch } ? Ch : unknown,
      void,
      unknown
    >,
  ): this {
    this._bag.streamGenerators.set(event, generator as any);
    return this;
  }

  /**
   * Runs BEFORE a client subscribes to this channel. Throw to reject the
   * subscribe — the client gets an `_error` frame. Use it for auth or
   * capacity checks. The optional `data` is whatever the client sent in
   * its `_subscribe` payload.
   */
  onBeforeSubscribe(
    handler: (ctx: ChannelCtx<ChC, C>, data?: unknown) => void | Promise<void>,
  ): this {
    this._bag.onBeforeSubscribeHandler = handler as any;
    return this;
  }

  /** Runs after a client successfully subscribes to this channel. */
  onSubscribe(handler: (ctx: ChannelCtx<ChC, C>) => void | Promise<void>): this {
    this._bag.onSubscribeHandler = handler as any;
    return this;
  }

  /** Runs when a client explicitly unsubscribes from this channel. */
  onUnsubscribe(handler: (ctx: ChannelCtx<ChC, C>) => void | Promise<void>): this {
    this._bag.onUnsubscribeHandler = handler as any;
    return this;
  }

  /**
   * Runs when a client's session in this channel ends — either via explicit
   * unsubscribe or because the underlying connection closed. Useful when you
   * want one cleanup hook regardless of how the session ended.
   */
  onSessionEnd(handler: (ctx: ChannelCtx<ChC, C>) => void | Promise<void>): this {
    this._bag.onSessionEndHandler = handler as any;
    return this;
  }

  /**
   * Middleware-style hook scoped to this channel.
   *
   * - `intercept(handler)` — runs BEFORE schema validation on every event in
   *   this channel. Throw to bail.
   * - `intercept(event, handler)` — runs AFTER validation, BEFORE the event
   *   handler. Scoped to one event in this channel.
   */
  intercept(
    handler: (ctx: ChannelCtx<ChC, C>, message: { event: string; payload: unknown }) => any,
  ): this;
  intercept<E extends keyof FieldOf<ChC, 'incoming'> & string>(
    event: E,
    handler: (ctx: ChannelCtx<ChC, C>, payload: FieldOf<ChC, 'incoming'>[E]) => any,
  ): this;
  intercept(arg1: any, arg2?: any): this {
    if (typeof arg1 === 'string') {
      this._bag.postIntercepts.set(arg1, arg2);
    } else {
      this._bag.preIntercept = arg1;
    }
    return this;
  }

  /**
   * Plug in your own replay logic for this channel. You provide an `onReplay`
   * (and optionally `onBeforeSend` / `onAfterSend`); your code owns where the
   * data lives and how it's resent.
   */
  customReplay(hooks: CustomReplayOptions<'channel'>): this {
    this._bag.customReplayHooks = hooks;
    return this;
  }
}
