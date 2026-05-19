/* oxlint-disable @typescript-eslint/no-explicit-any */
import { ChannelImplement } from '~/channel/implement.ts';
import type { Contract } from '~/_api/contract-types.ts';
import type { NamespaceCtx } from '~/_api/ctx-types.ts';
import type { FieldOf } from '~/channel/implement.ts';
import type { RateLimitConfig } from '~/rate-limit/rate-limit.ts';

// Everything a namespace sub-implementer collects, ready to be compiled.
export interface NamespaceHandlerBag {
  incomingHandlers: Map<string, (ctx: any, payload: any) => void | Promise<void>>;
  requestHandlers: Map<string, (ctx: any, payload: any) => any>;
  streamGenerators: Map<string, (ctx: any, payload: any) => AsyncGenerator<any, void, unknown>>;
  channelImpls: Map<string, ChannelImplement<any, any>>;
  preIntercept?: (ctx: any, message: { event: string; payload: unknown }) => any;
  postIntercepts: Map<string, (ctx: any, payload: any) => any>;
  rateLimitOverrides: Map<string, RateLimitConfig>;
}

/**
 * The builder you get inside `implement(c).namespace(name, ns => ...)`. Use
 * it to attach handlers, intercepts, and nested channel builders that only
 * apply inside this namespace.
 */
export class NamespaceImplement<C extends Contract, NsC = any> {
  /** @internal */
  readonly _bag: NamespaceHandlerBag = {
    incomingHandlers: new Map(),
    requestHandlers: new Map(),
    streamGenerators: new Map(),
    channelImpls: new Map(),
    postIntercepts: new Map(),
    rateLimitOverrides: new Map(),
  };

  /**
   * Attach a handler for one client→server event declared on this namespace.
   * Runs each time a client sends that event with the namespace marker.
   * `ctx.namespace.send` / `.broadcast` are scoped to this namespace.
   */
  on<E extends keyof FieldOf<NsC, 'incoming'> & string>(
    event: E,
    handler: (
      ctx: NamespaceCtx<NsC, C>,
      payload: FieldOf<NsC, 'incoming'>[E],
    ) => void | Promise<void>,
  ): this {
    this._bag.incomingHandlers.set(event, handler as any);
    return this;
  }

  /**
   * Attach a request/response handler scoped to this namespace. Return a
   * value or call `ctx.respond(value)`.
   */
  request<E extends keyof FieldOf<NsC, 'requests'> & string>(
    event: E,
    handler: (
      ctx: NamespaceCtx<NsC, C> & {
        respond(value: FieldOf<NsC, 'requests'>[E] extends { response: infer R } ? R : void): void;
      },
      payload: FieldOf<NsC, 'requests'>[E] extends { payload: infer P } ? P : never,
    ) =>
      | (FieldOf<NsC, 'requests'>[E] extends { response: infer R } ? R : void)
      | void
      | Promise<(FieldOf<NsC, 'requests'>[E] extends { response: infer R } ? R : void) | void>,
  ): this {
    this._bag.requestHandlers.set(event, handler as any);
    return this;
  }

  /** Attach the generator for a server-pushed stream scoped to this namespace. */
  stream<E extends keyof FieldOf<NsC, 'streams'> & string>(
    event: E,
    generator: (ctx: any, payload: any) => AsyncGenerator<any, void, unknown>,
  ): this {
    this._bag.streamGenerators.set(event, generator as any);
    return this;
  }

  /**
   * Wire up handlers for a channel that's nested inside this namespace.
   * The callback gets a channel sub-builder.
   */
  channel<N extends keyof FieldOf<NsC, 'channels'> & string>(
    name: N,
    fn: (ch: ChannelImplement<C, FieldOf<NsC, 'channels'>[N]>) => unknown,
  ): this {
    const impl = new ChannelImplement<C, FieldOf<NsC, 'channels'>[N]>();
    fn(impl);
    this._bag.channelImpls.set(name, impl);
    return this;
  }

  /**
   * Middleware-style hook scoped to this namespace.
   *
   * - `intercept(handler)` — runs BEFORE schema validation on every event in
   *   this namespace. Throw to bail.
   * - `intercept(event, handler)` — runs AFTER validation, BEFORE the event
   *   handler. Scoped to one event in this namespace.
   */
  intercept(
    handler: (ctx: NamespaceCtx<NsC, C>, message: { event: string; payload: unknown }) => any,
  ): this;
  intercept<E extends keyof FieldOf<NsC, 'incoming'> & string>(
    event: E,
    handler: (ctx: NamespaceCtx<NsC, C>, payload: FieldOf<NsC, 'incoming'>[E]) => any,
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
   * Override the resolved rate-limit rule for one event inside this namespace.
   * Missing fields fall back to the namespace's resolved rule.
   */
  rateLimit<
    E extends (
      | keyof FieldOf<NsC, 'incoming'>
      | keyof FieldOf<NsC, 'requests'>
      | keyof FieldOf<NsC, 'streams'>
    ) &
      string,
  >(event: E, config: RateLimitConfig): this {
    this._bag.rateLimitOverrides.set(event, config);
    return this;
  }
}
