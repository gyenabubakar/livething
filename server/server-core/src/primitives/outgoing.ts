import { definePrimitive } from '~/primitives/define.ts';
import type { Primitive } from '~/primitives/define.ts';
import type { TypeMarker } from '~/t.ts';

/**
 * The primitive instance returned by `outgoing()`. Carries the event name
 * and payload marker. `defineServer()` uses this to type `ctx.send()` and
 * `ctx.broadcast()`. `InferClient` reads it later to build the client
 * server -> client event map.
 */
export interface OutgoingPrimitive<
  TEvent extends string = string,
  TPayload = unknown,
> extends Primitive<'outgoing'> {
  readonly event: TEvent;
  readonly payload: TypeMarker<TPayload>;
}

const OUTGOING_KEY = Symbol('outgoing');

const _outgoing = definePrimitive({
  tag: 'outgoing' as const,
  key: OUTGOING_KEY,
  kind: 'contract' as const,
  registrationId(event: string, _payload: TypeMarker<unknown>) {
    return event;
  },
  create(event: string, payload: TypeMarker<unknown>) {
    return { event, payload };
  },
});

/**
 * Declare a server -> client event.
 *
 * ```ts
 * outgoing('message', t<{ text: string; from: string }>())
 * ```
 */
export function outgoing<TEvent extends string, TPayload>(
  event: TEvent,
  payload: TypeMarker<TPayload>,
): OutgoingPrimitive<TEvent, TPayload> {
  return _outgoing(event, payload) as unknown as OutgoingPrimitive<TEvent, TPayload>;
}

/** Dependency ref — use in `dependencies: [outgoing]` to assert it's registered. */
outgoing.__key = OUTGOING_KEY;
