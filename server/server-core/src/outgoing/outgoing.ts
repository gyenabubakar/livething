import type { Primitive } from '~/primitive.ts';

export interface OutgoingPrimitive<
  TEvent extends string = string,
  _TPayload = unknown,
> extends Primitive<'outgoing'> {
  readonly event: TEvent;
}

const OUTGOING_KEY = Symbol('outgoing');

export function outgoing<TEvent extends string, TPayload = unknown>(
  event: TEvent,
): OutgoingPrimitive<TEvent, TPayload> {
  return {
    __wskit: 'outgoing',
    __kind: 'contract',
    __identity: [OUTGOING_KEY, event],
    __dependencies: [],
    __requires: {},
    event,
  };
}

outgoing.__key = OUTGOING_KEY;
