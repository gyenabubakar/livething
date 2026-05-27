/* oxlint-disable @typescript-eslint/no-explicit-any */
import { setOnce } from '~/_api/handler-maps.ts';
import type { Contract } from '~/_api/contract-types.ts';
import type { NamespaceCtx } from '~/_api/ctx-types.ts';
import type { FieldOf } from '~/channel/implement.ts';
import type { InterceptFrame } from '~/intercept/intercept.ts';
import type { RateLimitConfig } from '~/rate-limit/rate-limit.ts';

// Everything a namespace sub-implementer collects, ready to be compiled.
export interface NamespaceHandlerBag {
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
  intercept?: (ctx: any, frame: InterceptFrame) => any;
  rateLimitOverrides: Map<string, RateLimitConfig>;
}

/**
 * The builder you get inside `implement(c).namespace(name, ns => ...)`. Use
 * it to attach handlers and intercepts that apply only inside this namespace.
 */
export class NamespaceImplement<C extends Contract, NsC = any> {
  /** @internal */
  readonly _bag: NamespaceHandlerBag = {
    incomingHandlers: new Map(),
    requestHandlers: new Map(),
    streamGenerators: new Map(),
    resumableStreamGenerators: new Map(),
    recordedStreamGenerators: new Map(),
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
    setOnce(this._bag.incomingHandlers, event, {
      value: handler as any,
      kind: 'incoming',
      where: 'this namespace',
    });
    return this;
  }

  /**
   * Attach a request/response handler scoped to this namespace. Call
   * `ctx.respond(value)`.
   */
  request<E extends keyof FieldOf<NsC, 'requests'> & string>(
    event: E,
    handler: (
      ctx: NamespaceCtx<NsC, C> & {
        respond(value: FieldOf<NsC, 'requests'>[E] extends { response: infer R } ? R : void): void;
      },
      payload: FieldOf<NsC, 'requests'>[E] extends { payload: infer P } ? P : never,
    ) => void | Promise<void>,
  ): this {
    setOnce(this._bag.requestHandlers, event, {
      value: handler as any,
      kind: 'request',
      where: 'this namespace',
    });
    return this;
  }

  /** Attach the generator for a server-pushed stream scoped to this namespace. */
  stream<E extends keyof FieldOf<NsC, 'streams'> & string>(
    event: E,
    generator: (ctx: any, payload: any) => AsyncGenerator<any, void, unknown>,
  ): this {
    setOnce(this._bag.streamGenerators, event, {
      value: generator as any,
      kind: 'stream',
      where: 'this namespace',
    });
    return this;
  }

  /** Attach the generator for a resumable stream scoped to this namespace. */
  resumableStream<E extends keyof FieldOf<NsC, 'resumableStreams'> & string>(
    event: E,
    generator: (ctx: any, payload: any) => AsyncGenerator<any, void, unknown>,
  ): this {
    setOnce(this._bag.resumableStreamGenerators, event, {
      value: generator,
      kind: 'resumableStream',
      where: 'this namespace',
    });
    return this;
  }

  /** Attach the generator for a recorded stream scoped to this namespace. */
  recordedStream<E extends keyof FieldOf<NsC, 'recordedStreams'> & string>(
    event: E,
    generator: (ctx: any, payload: any) => AsyncGenerator<any, void, unknown>,
  ): this {
    setOnce(this._bag.recordedStreamGenerators, event, {
      value: generator,
      kind: 'recordedStream',
      where: 'this namespace',
    });
    return this;
  }

  /**
   * Middleware-style hook scoped to this namespace. Runs before schema
   * validation on every event in this namespace. Throw `Block` to drop the
   * frame, `Disconnect` to close the connection, or return a new value to
   * replace the payload.
   *
   * Use `contract.matches(...)` or `contract.unsafeCast(...)` inside the
   * handler to narrow `frame.payload` to a typed shape per event.
   */
  intercept(handler: (ctx: NamespaceCtx<NsC, C>, frame: InterceptFrame) => any): this {
    if (this._bag.intercept) {
      throw new Error(
        '[wskit] Duplicate intercept on this namespace. Only one intercept can be attached.',
      );
    }
    this._bag.intercept = handler;
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
    setOnce(this._bag.rateLimitOverrides, event, {
      value: config,
      kind: 'rateLimit override',
      where: 'this namespace',
    });
    return this;
  }
}
