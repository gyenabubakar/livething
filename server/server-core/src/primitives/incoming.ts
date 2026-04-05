/* oxlint-disable @typescript-eslint/no-explicit-any */
import { definePrimitive } from '~/primitives/define.ts';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { Primitive } from '~/primitives/define.ts';
import type { Validator } from '~/types.ts';

/**
 * The handler function for an incoming event. Receives the connection
 * context and the validated payload.
 *
 * `ctx` is typed as `any` here — `defineServer` narrows it based on
 * which primitives are registered (e.g. ack adds `ctx.ack()`).
 */
export type IncomingHandler<TPayload = unknown> = (
  ctx: any,
  payload: TPayload,
) => void | Promise<void>;

/**
 * The primitive instance returned by `incoming()`. Carries the event name,
 * handler, and optional validator. `InferClientType` reads `TEvent` and
 * `TPayload` to produce the client's `outgoing` type.
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
> extends Primitive<'incoming'> {
  readonly event: TEvent;
  readonly handler: IncomingHandler<TPayload>;
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
 * The event name is preserved as a literal type for `InferClientType`.
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
export function incoming<TEvent extends string>(
  event: TEvent,
  handler: IncomingHandler<unknown>,
): IncomingPrimitive<TEvent, unknown>;
export function incoming<TEvent extends string, TPayload>(
  event: TEvent,
  handler: IncomingHandler<TPayload>,
  options: { validator: (value: unknown) => TPayload },
): IncomingPrimitive<TEvent, TPayload>;
export function incoming<TEvent extends string, TSchema extends StandardSchemaV1>(
  event: TEvent,
  handler: IncomingHandler<StandardSchemaV1.InferOutput<TSchema>>,
  options: { validator: TSchema },
): IncomingPrimitive<TEvent, StandardSchemaV1.InferOutput<TSchema>>;
export function incoming(
  event: string,
  handler: IncomingHandler,
  options?: { validator?: Validator },
): IncomingPrimitive {
  return _incoming(event, handler, options) as unknown as IncomingPrimitive;
}

/** Dependency ref — use in `dependencies: [incoming]` to assert it's registered. */
incoming.__key = INCOMING_KEY;
