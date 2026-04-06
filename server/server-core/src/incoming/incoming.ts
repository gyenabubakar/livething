/* oxlint-disable @typescript-eslint/no-explicit-any */
import { unwrapHandled } from '~/h.ts';
import { definePrimitive } from '~/primitive.ts';
import type { Handled } from '~/h.ts';
import type { Primitive } from '~/primitive.ts';
import type { ReceivedEvent } from '~/received.ts';
import type { Validator } from '~/types.ts';

/**
 * The handler function for an incoming event. Receives the connection
 * context and the validated payload.
 *
 * `incoming()` just carries the handler type through. `defineServer()`
 * gives `ctx` its final type later based on what is registered in the
 * same scope.
 *
 * When you want fully typed `ctx` in editor hover, wrap the callback in
 * `h(...)`. This is a TypeScript workaround.
 */
export type IncomingHandler<TCtx = any, TPayload = unknown> = (
  ctx: TCtx,
  payload: TPayload,
) => void | Promise<void>;

/**
 * The primitive instance returned by `incoming()`.
 *
 * It represents one client -> server event handler, including the event
 * name, the handler function, and the optional validator. `InferClient`
 * reads it later to understand what the client is allowed to send.
 *
 * ```ts
 * const sendMessage = received('send-message', (value: unknown) => value as {
 *   text: string;
 * });
 *
 * incoming(sendMessage, h(async (ctx, payload) => {
 *   ctx.broadcast('message', { text: payload.text, from: ctx.meta.userId });
 * }))
 * ```
 */
export interface IncomingPrimitive<
  TEvent extends string = string,
  TPayload = unknown,
  TCtx = any,
> extends Primitive<'incoming'> {
  readonly event: TEvent;
  readonly handler: IncomingHandler<TCtx, TPayload>;
  readonly validator?: Validator<TPayload>;
}

type ReceivedEventName<TReceived extends ReceivedEvent<string, unknown>> =
  TReceived extends ReceivedEvent<infer TEvent, unknown> ? TEvent : never;

type ReceivedPayload<TReceived extends ReceivedEvent<string, unknown>> =
  TReceived extends ReceivedEvent<string, infer TPayload> ? TPayload : never;

// ---------------------------------------------------------------------------
// Runtime factory (loosely typed — the public wrapper adds generics)
// ---------------------------------------------------------------------------

const INCOMING_KEY = Symbol('incoming');

const _incoming = definePrimitive({
  tag: 'incoming' as const,
  key: INCOMING_KEY,
  kind: 'handler' as const,
  registrationId(event: string, _handler: any, _options?: any) {
    return event;
  },
  create(event: string, handler: IncomingHandler, options?: { validator?: Validator }) {
    return { event, handler, validator: options?.validator };
  },
});

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Handle an incoming event from the client.
 *
 * Pass a contract created by `received(...)`. That keeps the event name
 * and payload validator together in one place, which makes the API easier
 * to read and helps TypeScript type the handler more reliably.
 *
 * **Without validator** — payload is `unknown`, validate manually:
 * ```ts
 * const heartbeatCheck = received('heartbeat-check');
 *
 * incoming(heartbeatCheck, h(async (ctx) => {
 *   ctx.send('heartbeat-ack', {});
 * }))
 * ```
 *
 * **With parse function** — payload type inferred from return:
 * ```ts
 * const sendMessage = received('send-message', (p: unknown) => {
 *   const obj = p as Record<string, unknown>;
 *   if (typeof obj.text !== 'string') throw new Error('text required');
 *   return { text: obj.text };
 * });
 *
 * incoming(sendMessage, h(async (ctx, payload) => {
 *   payload.text; // string — inferred from validator
 * }))
 * ```
 *
 * **With StandardSchema** — payload type inferred from schema output:
 * ```ts
 * const sendMessage = received('send-message', v.object({ text: v.string() }));
 *
 * incoming(sendMessage, h(async (ctx, payload) => {
 *   payload.text; // string — inferred from valibot schema
 * }))
 * ```
 */
export function incoming<TCtx, TReceived extends ReceivedEvent<string, unknown>>(
  event: TReceived,
  handler: Handled<IncomingHandler<TCtx, ReceivedPayload<TReceived>>, ReceivedPayload<TReceived>>,
): IncomingPrimitive<ReceivedEventName<TReceived>, ReceivedPayload<TReceived>, TCtx>;
export function incoming<TCtx, TReceived extends ReceivedEvent<string, unknown>>(
  event: TReceived,
  handler: IncomingHandler<TCtx, ReceivedPayload<TReceived>>,
): IncomingPrimitive<ReceivedEventName<TReceived>, ReceivedPayload<TReceived>, TCtx>;
export function incoming<TReceived extends ReceivedEvent<string, unknown>>(
  event: TReceived,
  handler: IncomingHandler<any, ReceivedPayload<TReceived>>,
): IncomingPrimitive<ReceivedEventName<TReceived>, ReceivedPayload<TReceived>, any>;
export function incoming(
  event: ReceivedEvent<string, unknown>,
  handler: IncomingHandler<any, any> | Handled<IncomingHandler<any, any>>,
): IncomingPrimitive {
  const validator = event.validator;
  const eventName = event.event;

  return _incoming(
    eventName,
    unwrapHandled(handler),
    validator ? { validator } : undefined,
  ) as unknown as IncomingPrimitive;
}

/** Dependency ref — use in `dependencies: [incoming]` to assert it's registered. */
incoming.__key = INCOMING_KEY;
