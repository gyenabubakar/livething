/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { Primitive } from '~/primitive.ts';
import type { Validator } from '~/types.ts';

export type IncomingHandler<TCtx = any, TPayload = unknown> = (
  ctx: TCtx,
  payload: TPayload,
) => void | Promise<void>;

export interface IncomingPrimitive<
  TEvent extends string = string,
  TPayload = unknown,
  TCtx = any,
> extends Primitive<'incoming'> {
  readonly event: TEvent;
  readonly handler: IncomingHandler<TCtx, TPayload>;
  readonly validator?: Validator<TPayload>;
}

const INCOMING_KEY = Symbol('incoming');

export function incoming<TEvent extends string, TPayload, TCtx = any>(
  event: TEvent,
  handler: IncomingHandler<TCtx, TPayload>,
  options?: { validator?: Validator<TPayload> },
): IncomingPrimitive<TEvent, TPayload, TCtx> {
  return {
    __wskit: 'incoming',
    __kind: 'handler',
    __identity: [INCOMING_KEY, event],
    __dependencies: [],
    __requires: {},
    event,
    handler,
    validator: options?.validator,
  };
}

incoming.__key = INCOMING_KEY;
