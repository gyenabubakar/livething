/* oxlint-disable @typescript-eslint/no-explicit-any */
import { assertValidWSKitIdentifier } from '@wskit/core';
import type { Primitive } from '~/primitive.ts';
import type { Validator } from '~/types.ts';

/** Handler function for a client→server event. */
export type IncomingHandler<TCtx = any, TPayload = unknown> = (
  ctx: TCtx,
  payload: TPayload,
) => void | Promise<void>;

/**
 * Primitive behind `base.on(...)`. Carries the event name, handler, and
 * optional validator so the engine can dispatch and validate messages.
 */
export interface IncomingPrimitive<
  TEvent extends string = string,
  TPayload = unknown,
  TCtx = any,
> extends Primitive<'incoming'> {
  /** The event name the client must send to trigger this handler. */
  readonly event: TEvent;
  /** The function to call when the event is received. */
  readonly handler: IncomingHandler<TCtx, TPayload>;
  /**
   * Optional schema validator. When present, the engine validates the raw
   * payload before calling `handler`. If validation fails, `onValidationError`
   * fires instead.
   */
  readonly validator?: Validator<TPayload>;
}

/** Unique symbol. The registration ID is the event name, so each event is its own singleton. */
const INCOMING_KEY = Symbol('incoming');

/**
 * Internal primitive factory. The user-facing surface for declaring a
 * client→server event is `base.on(...)`. This factory is called by the compile
 * step to bind a registered handler to an `IncomingDef`.
 */
export function incoming<TEvent extends string, TPayload, TCtx = any>(
  event: TEvent,
  handler: IncomingHandler<TCtx, TPayload>,
  options?: { validator?: Validator<TPayload> },
): IncomingPrimitive<TEvent, TPayload, TCtx> {
  assertValidWSKitIdentifier(event, 'incoming() event name');
  return {
    __wskit: 'incoming',
    __kind: 'handler',
    __identity: [INCOMING_KEY, event],
    __requires: {},
    event,
    handler,
    validator: options?.validator,
  };
}

/**
 * Symbol key used to reference this primitive in dependency declarations.
 */
incoming.__key = INCOMING_KEY;
