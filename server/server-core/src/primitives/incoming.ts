/* oxlint-disable @typescript-eslint/no-explicit-any */
import { definePrimitive } from '~/primitives/define.ts';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { Primitive } from '~/primitives/define.ts';
import type { Validator } from '~/types.ts';

/**
 * The handler function for an incoming event. Receives the connection
 * context and the validated payload.
 *
 * `incoming()` just carries the handler type through. `defineServer()`
 * gives `ctx` its final type later based on what is registered in the
 * same scope.
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
 * incoming('send-message', async (ctx, payload) => {
 *   ctx.broadcast('message', { text: payload.text, from: ctx.meta.userId });
 * }, { validator: SendMessageValidator })
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
 * The event name is preserved as a literal type for `InferClient`.
 * The payload type is inferred from the validator (if provided).
 *
 * **Without validator** — payload is `unknown`, validate manually:
 * ```ts
 * incoming('heartbeat-check', async (ctx) => {
 *   ctx.send('heartbeat-ack', {});
 * })
 * ```
 *
 * **With parse function** — payload type inferred from return:
 * ```ts
 * incoming('send-message', async (ctx, payload) => {
 *   payload.text; // string — inferred from validator
 * }, {
 *   validator: (p) => {
 *     const obj = p as Record<string, unknown>;
 *     if (typeof obj.text !== 'string') throw new Error('text required');
 *     return { text: obj.text };
 *   }
 * })
 * ```
 *
 * **With StandardSchema** — payload type inferred from schema output:
 * ```ts
 * incoming('send-message', async (ctx, payload) => {
 *   payload.text; // string — inferred from valibot schema
 * }, { validator: v.object({ text: v.string() }) })
 * ```
 */
export function incoming<TCtx, TEvent extends string>(
  event: TEvent,
  handler: IncomingHandler<TCtx, unknown>,
): IncomingPrimitive<TEvent, unknown, TCtx>;
export function incoming<TCtx, TEvent extends string, TPayload>(
  event: TEvent,
  handler: IncomingHandler<TCtx, TPayload>,
  options: { validator: (value: unknown) => TPayload },
): IncomingPrimitive<TEvent, TPayload, TCtx>;
export function incoming<TCtx, TEvent extends string, TSchema extends StandardSchemaV1>(
  event: TEvent,
  handler: IncomingHandler<TCtx, StandardSchemaV1.InferOutput<TSchema>>,
  options: { validator: TSchema },
): IncomingPrimitive<TEvent, StandardSchemaV1.InferOutput<TSchema>, TCtx>;
export function incoming<TEvent extends string>(
  event: TEvent,
  handler: IncomingHandler<any, unknown>,
): IncomingPrimitive<TEvent, unknown, any>;
export function incoming<TEvent extends string, TPayload>(
  event: TEvent,
  handler: IncomingHandler<any, TPayload>,
  options: { validator: (value: unknown) => TPayload },
): IncomingPrimitive<TEvent, TPayload, any>;
export function incoming<TEvent extends string, TSchema extends StandardSchemaV1>(
  event: TEvent,
  handler: IncomingHandler<any, StandardSchemaV1.InferOutput<TSchema>>,
  options: { validator: TSchema },
): IncomingPrimitive<TEvent, StandardSchemaV1.InferOutput<TSchema>, any>;
export function incoming(
  event: string,
  handler: IncomingHandler<any, any>,
  options?: { validator?: Validator },
): IncomingPrimitive {
  return _incoming(event, handler, options) as unknown as IncomingPrimitive;
}

/** Dependency ref — use in `dependencies: [incoming]` to assert it's registered. */
incoming.__key = INCOMING_KEY;
