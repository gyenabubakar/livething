import type { Primitive } from '~/primitive.ts';

/**
 * Engine-side primitive for an outgoing event. Carries the event name and a
 * phantom payload type so WSKit can type-check server-to-client sends and
 * generate the matching client types.
 *
 * `_TPayload` is only used for typing. It is not stored on the primitive at
 * runtime, which is why the name starts with an underscore.
 */
export interface OutgoingPrimitive<
  TEvent extends string = string,
  _TPayload = unknown,
> extends Primitive<'outgoing'> {
  /** The event name the server emits. */
  readonly event: TEvent;
}

/** Unique symbol. The registration ID is the event name, so each event is its own singleton. */
const OUTGOING_KEY = Symbol('outgoing');

/**
 * Internal primitive factory. The user-facing surface for declaring an outgoing
 * event is the `emits({...})` capability. This factory is called by the compile
 * step to produce the engine-side primitive from each declared emit.
 *
 * @param event The event name exactly as the client will receive it.
 */
export function outgoing<TEvent extends string, TPayload = unknown>(
  event: TEvent,
): OutgoingPrimitive<TEvent, TPayload> {
  return {
    __wskit: 'outgoing',
    __kind: 'contract',
    __identity: [OUTGOING_KEY, event],
    __requires: {},
    event,
  };
}

/**
 * Symbol key used to reference this primitive in dependency declarations.
 */
outgoing.__key = OUTGOING_KEY;
