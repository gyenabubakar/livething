import type { Primitive } from '~/primitive.ts';

/**
 * The primitive type produced by `outgoing()`. It keeps track of the event
 * name and payload type so wskit can type-check server-to-client sends and
 * generate the matching client types.
 *
 * `_TPayload` is only used for typing. It is not stored on the primitive at
 * runtime, which is why the name starts with an underscore.
 */
export interface OutgoingPrimitive<
  TEvent extends string = string,
  _TPayload = unknown,
> extends Primitive<'outgoing'> {
  /** The event name as declared in the `EventContract`. */
  readonly event: TEvent;
}

/** Unique symbol. The registration ID is the event name, so each event is its own singleton. */
const OUTGOING_KEY = Symbol('outgoing');

/**
 * Creates an outgoing event declaration primitive. Registering this primitive
 * tells the engine that the server will send an event with this name, and allows
 * the type generator to include it in the client's event map.
 *
 * Outgoing declarations are `'contract'` kind — they do not install any runtime
 * behaviour. They exist purely so the generated client types stay accurate.
 *
 * In practice you rarely call `outgoing()` directly. Use it through the builder:
 * `server('name').outgoing(myEventContract)` — that method calls this factory
 * internally.
 *
 * @param event The event name exactly as the client will receive it.
 *
 * @example
 * ```ts
 * import { server, event } from '@wskit/server';
 * import * as v from 'valibot';
 *
 * const MessageSchema = v.object({ text: v.string() });
 * const Messages = event('messages', v.array(MessageSchema));
 *
 * server('chat')
 *   .outgoing(Messages) // same as calling outgoing(Messages.event) under the hood
 *   .onConnect((ctx) => {
 *     ctx.send('messages', []);
 *   });
 * ```
 */
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

/**
 * Symbol key used to reference this primitive in dependency declarations.
 */
outgoing.__key = OUTGOING_KEY;
