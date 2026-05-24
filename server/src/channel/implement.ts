/* oxlint-disable @typescript-eslint/no-explicit-any */
import { setOnce } from '~/_api/handler-maps.ts';
import type { Contract } from '~/_api/contract-types.ts';
import type { ChannelCtx } from '~/_api/ctx-types.ts';
import type { InterceptFrame } from '~/intercept/intercept.ts';
import type { RateLimitConfig } from '~/rate-limit/rate-limit.ts';
import type { CustomReplayOptions } from '~/replay/custom/custom.ts';

// Reads one slot (incoming / requests / streams / etc.) off a sub-contract
// so the .on() / .request() / .stream() methods below get per-event types.
export type FieldOf<T, K extends string> = T extends Record<K, infer V> ? V : Record<string, any>;

// Extracts the subscribe payload type from a channel contract when a check
// validator is declared on the channel. Falls back to `unknown` otherwise.
type SubscribePayloadOf<TChC> = 'subscribePayload' extends keyof TChC
  ? TChC['subscribePayload']
  : unknown;

// Everything a channel sub-implementer collects, ready to be compiled.
export interface ChannelHandlerBag {
  incomingHandlers: Map<string, (ctx: any, payload: any) => void | Promise<void>>;
  requestHandlers: Map<string, (ctx: any, payload: any) => any>;
  streamGenerators: Map<string, (ctx: any, payload: any) => AsyncGenerator<any, void, unknown>>;
  resumableStreamGenerators: Map<
    string,
    (ctx: any, payload: any) => AsyncGenerator<any, void, unknown>
  >;
  recordedStreamGenerators: Map<
    string,
    (ctx: any, payload: any) => AsyncGenerator<any, void, unknown>
  >;
  checkHandler?: (ctx: any, data?: any) => unknown | Promise<unknown>;
  commitHandler?: (ctx: any, checkResult: unknown) => void;
  onSubscribeHandler?: (ctx: any) => void | Promise<void>;
  onUnsubscribeHandler?: (ctx: any) => void | Promise<void>;
  onSessionEndHandler?: (ctx: any) => void | Promise<void>;
  intercept?: (ctx: any, frame: InterceptFrame) => any;
  rateLimitOverrides: Map<string, RateLimitConfig>;
  customReplayHooks?: CustomReplayOptions<'channel'>;
}

/**
 * The builder you get inside `implement(c).channel(name, ch => ...)`. Use it
 * to attach handlers, lifecycle hooks, intercepts, and a custom replay
 * strategy that only apply inside this channel.
 */
export class ChannelImplement<C extends Contract, ChC = any, TCheck = unknown> {
  /** @internal */
  readonly _bag: ChannelHandlerBag = {
    incomingHandlers: new Map(),
    requestHandlers: new Map(),
    streamGenerators: new Map(),
    resumableStreamGenerators: new Map(),
    recordedStreamGenerators: new Map(),
    rateLimitOverrides: new Map(),
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
    setOnce(this._bag.incomingHandlers, event, {
      value: handler as any,
      kind: 'incoming',
      where: 'this channel',
    });
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
    setOnce(this._bag.requestHandlers, event, {
      value: handler as any,
      kind: 'request',
      where: 'this channel',
    });
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
    setOnce(this._bag.streamGenerators, event, {
      value: generator as any,
      kind: 'stream',
      where: 'this channel',
    });
    return this;
  }

  /** Attach the generator for a resumable stream scoped to this channel. */
  resumableStream<E extends keyof FieldOf<ChC, 'resumableStreams'> & string>(
    event: E,
    generator: (ctx: any, payload: any) => AsyncGenerator<any, void, unknown>,
  ): this {
    setOnce(this._bag.resumableStreamGenerators, event, {
      value: generator,
      kind: 'resumableStream',
      where: 'this channel',
    });
    return this;
  }

  /** Attach the generator for a recorded stream scoped to this channel. */
  recordedStream<E extends keyof FieldOf<ChC, 'recordedStreams'> & string>(
    event: E,
    generator: (ctx: any, payload: any) => AsyncGenerator<any, void, unknown>,
  ): this {
    setOnce(this._bag.recordedStreamGenerators, event, {
      value: generator,
      kind: 'recordedStream',
      where: 'this channel',
    });
    return this;
  }

  /**
   * Run an async check before a client is allowed into this channel.
   *
   * Whatever you return is passed as the second argument to `.commit()` —
   * TypeScript infers the type automatically. Throw to deny the subscribe.
   *
   * To validate the subscribe payload, declare `check` on the channel in the
   * contract — `channel('room', { check: mySchema, definitions: [...] })`.
   *
   * @example
   * ```ts
   * ch.check(async (ctx, data?: { token: string }) => {
   *   const user = await db.verifyToken(data?.token);
   *   if (!user) throw Block(Forbidden());
   *   return user; // available in commit() below
   * })
   * ```
   */
  check<TData = SubscribePayloadOf<ChC>, TResult = unknown>(
    handler: (ctx: ChannelCtx<ChC, C>, data?: TData) => TResult | Promise<TResult>,
  ): ChannelImplement<C, ChC, TResult> {
    if (this._bag.checkHandler) {
      throw new Error(
        '[wskit] Duplicate .check() on this channel. Only one check hook can be attached.',
      );
    }
    this._bag.checkHandler = handler as any;
    return this as any as ChannelImplement<C, ChC, TResult>;
  }

  /**
   * Run a final sync check right before this subscriber is added to the channel.
   *
   * Receives the value returned by `.check()` — TypeScript knows the type.
   * Throw to deny the subscribe.
   *
   * Must be synchronous. Do not use `async` or return a `Promise`.
   *
   * @example
   * ```ts
   * ch.commit((ctx, user) => {
   *   if (ctx.channels.get('room').members().length >= 50) {
   *     throw Block(CapacityReached());
   *   }
   * })
   * ```
   */
  commit(handler: (ctx: ChannelCtx<ChC, C>, checkResult: TCheck) => void): this {
    if (this._bag.commitHandler) {
      throw new Error(
        '[wskit] Duplicate .commit() on this channel. Only one commit hook can be attached.',
      );
    }
    this._bag.commitHandler = handler as any;
    return this;
  }

  /** Runs after a client successfully subscribes to this channel. */
  onSubscribe(handler: (ctx: ChannelCtx<ChC, C>) => void | Promise<void>): this {
    if (this._bag.onSubscribeHandler) {
      throw new Error(
        '[wskit] Duplicate .onSubscribe() on this channel. Only one hook can be attached.',
      );
    }
    this._bag.onSubscribeHandler = handler as any;
    return this;
  }

  /** Runs when a client explicitly unsubscribes from this channel. */
  onUnsubscribe(handler: (ctx: ChannelCtx<ChC, C>) => void | Promise<void>): this {
    if (this._bag.onUnsubscribeHandler) {
      throw new Error(
        '[wskit] Duplicate .onUnsubscribe() on this channel. Only one hook can be attached.',
      );
    }
    this._bag.onUnsubscribeHandler = handler as any;
    return this;
  }

  /**
   * Runs when a client's session in this channel ends — either via explicit
   * unsubscribe or because the underlying connection closed. Useful when you
   * want one cleanup hook regardless of how the session ended.
   */
  onSessionEnd(handler: (ctx: ChannelCtx<ChC, C>) => void | Promise<void>): this {
    if (this._bag.onSessionEndHandler) {
      throw new Error(
        '[wskit] Duplicate .onSessionEnd() on this channel. Only one hook can be attached.',
      );
    }
    this._bag.onSessionEndHandler = handler as any;
    return this;
  }

  /**
   * Middleware-style hook scoped to this channel. Runs before schema
   * validation on every event in this channel. Throw `Block` to drop the
   * frame, `Disconnect` to close the connection, or return a new value to
   * replace the payload.
   *
   * Use `contract.matches(...)` or `contract.unsafeCast(...)` inside the
   * handler to narrow `frame.payload` to a typed shape per event.
   */
  intercept(handler: (ctx: ChannelCtx<ChC, C>, frame: InterceptFrame) => any): this {
    if (this._bag.intercept) {
      throw new Error(
        '[wskit] Duplicate intercept on this channel. Only one intercept can be attached.',
      );
    }
    this._bag.intercept = handler;
    return this;
  }

  /**
   * Override the resolved rate-limit rule for one event inside this channel.
   *
   * The override sits below the cascade — channel `rateLimit:`, then namespace,
   * then contract — and applies only to this one event. Missing fields fall
   * back to the channel's resolved rule.
   *
   * @example
   * ```ts
   * implement(chat).channel('rooms', (ch) => ch
   *   .rateLimit('send', { enabled: true, max: 10 })
   *   .on('send', (ctx, p) => ctx.channel.broadcast('msg', p))
   * );
   * ```
   */
  rateLimit<
    E extends (
      | keyof FieldOf<ChC, 'incoming'>
      | keyof FieldOf<ChC, 'requests'>
      | keyof FieldOf<ChC, 'streams'>
    ) &
      string,
  >(event: E, config: RateLimitConfig): this {
    setOnce(this._bag.rateLimitOverrides, event, {
      value: config,
      kind: 'rateLimit override',
      where: 'this channel',
    });
    return this;
  }

  /**
   * Plug in your own replay logic for this channel. You provide an `onReplay`
   * (and optionally `onBeforeSend` / `onAfterSend`); your code owns where the
   * data lives and how it's resent.
   */
  customReplay(hooks: CustomReplayOptions<'channel'>): this {
    if (this._bag.customReplayHooks) {
      throw new Error(
        '[wskit] Duplicate .customReplay() on this channel. Only one custom-replay strategy can be attached.',
      );
    }
    this._bag.customReplayHooks = hooks;
    return this;
  }
}
