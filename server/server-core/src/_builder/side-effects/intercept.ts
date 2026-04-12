/* oxlint-disable @typescript-eslint/no-explicit-any */
/**
 * Side-effect import that adds `.intercept()` to the server and group builders.
 *
 * Import path: `import '@wskit/server/intercept'`
 * Adds method: `.intercept(handler)` or `.intercept(event, handler)`
 *
 * `.intercept()` has two forms:
 *
 * **Pre-intercept** (no event name): runs before the payload is dispatched to
 * any handler. Receives the raw `{ event, payload }` message. Can transform it
 * by returning a new `InterceptMessage`, or skip it entirely by returning
 * `undefined`. Useful for logging, auth checks, or message transformation across
 * all events.
 *
 * **Post-intercept** (with event name): runs after the matching `incoming` or
 * `request` handler has dispatched the payload to its validation step but before
 * the application handler is called. Can transform the payload for that specific
 * event only.
 *
 * This file uses module augmentation (`declare module`) to teach TypeScript
 * about the new method and prototype patching to add the runtime implementation.
 */

import { GroupBuilder, ServerBuilder } from '~/_builder/server-builder.ts';
import { intercept as createIntercept } from '~/intercept/intercept.ts';
import type { HandlerCtxFromState, ScopeStateShape } from '~/_types/scope-state.ts';
import type { InterceptMessage } from '~/intercept/intercept.ts';
import type { Primitive } from '~/primitive.ts';

/**
 * Module augmentation: adds both `.intercept()` overloads to the builder
 * interfaces so TypeScript recognises the method after this file is imported.
 *
 * Note that `.intercept()` does not change the builder's type-level state
 * (`TState`). Interceptors are middleware — they don't add new events or
 * capabilities to the generated ctx.
 */
declare module '~/_builder/server-builder.ts' {
  interface ServerBuilder<TState extends ScopeStateShape> {
    /**
     * Register a pre-intercept that runs for every incoming message before it
     * is dispatched. Return a new `InterceptMessage` to transform the message,
     * or return `void` / `undefined` to pass it through unchanged.
     */
    intercept(
      handler: (
        ctx: HandlerCtxFromState<TState>,
        message: InterceptMessage,
      ) => InterceptMessage | void | Promise<InterceptMessage | void>,
    ): ServerBuilder<TState>;

    /**
     * Register a post-intercept for a single event. Runs after the event is
     * matched but before the application handler is called. Return a new payload
     * to transform it, or return `void` to pass it through unchanged.
     */
    intercept<TEvent extends string>(
      event: TEvent,
      handler: (ctx: HandlerCtxFromState<TState>, payload: any) => any,
    ): ServerBuilder<TState>;
  }

  interface GroupBuilder<TState extends ScopeStateShape> {
    /** Pre-intercept: runs for every incoming message before dispatch. */
    intercept(
      handler: (
        ctx: HandlerCtxFromState<TState>,
        message: InterceptMessage,
      ) => InterceptMessage | void | Promise<InterceptMessage | void>,
    ): GroupBuilder<TState>;

    /** Post-intercept: runs for a single event before the application handler. */
    intercept<TEvent extends string>(
      event: TEvent,
      handler: (ctx: HandlerCtxFromState<TState>, payload: any) => any,
    ): GroupBuilder<TState>;
  }
}

/**
 * Runtime implementation of `.intercept()` for `ServerBuilder`.
 *
 * When `firstArg` is a string, the call is a post-intercept targeting a
 * specific event. Otherwise it is a pre-intercept for all events.
 */
ServerBuilder.prototype.intercept = function (
  this: ServerBuilder<any>,
  firstArg: any,
  secondArg?: any,
) {
  if (typeof firstArg === 'string') {
    this._primitives.push(createIntercept(firstArg, secondArg) as unknown as Primitive);
  } else {
    this._primitives.push(createIntercept(firstArg) as unknown as Primitive);
  }
  return this;
};

/** Runtime implementation of `.intercept()` for `GroupBuilder`. */
GroupBuilder.prototype.intercept = function (
  this: GroupBuilder<any>,
  firstArg: any,
  secondArg?: any,
) {
  if (typeof firstArg === 'string') {
    this._primitives.push(createIntercept(firstArg, secondArg) as unknown as Primitive);
  } else {
    this._primitives.push(createIntercept(firstArg) as unknown as Primitive);
  }
  return this;
};
