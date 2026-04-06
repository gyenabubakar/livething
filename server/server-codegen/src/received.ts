import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { Validator } from '~/types.ts';

/**
 * A reusable incoming event contract.
 *
 * This pairs an event name with its validator ahead of time so you can pass
 * the whole contract into `incoming(...)`. Keeping the contract and handler
 * close together gives TypeScript an easier shape to understand.
 */
export interface ReceivedEvent<TEvent extends string = string, TPayload = unknown> {
  readonly __wskit: 'received';
  readonly event: TEvent;
  readonly validator?: Validator<TPayload>;
}

/**
 * Define a reusable incoming event contract.
 *
 * ```ts
 * const sendMessage = received('send-message', (value: unknown) => value as {
 *   text: string;
 * });
 *
 * incoming(sendMessage, async (ctx, payload) => {
 *   ctx.send('message', { text: payload.text });
 * });
 * ```
 */
export function received<TEvent extends string>(event: TEvent): ReceivedEvent<TEvent, unknown>;
export function received<TEvent extends string, TPayload>(
  event: TEvent,
  validator: (value: unknown) => TPayload,
): ReceivedEvent<TEvent, TPayload>;
export function received<TEvent extends string, TSchema extends StandardSchemaV1>(
  event: TEvent,
  validator: TSchema,
): ReceivedEvent<TEvent, StandardSchemaV1.InferOutput<TSchema>>;
export function received(event: string, validator?: Validator): ReceivedEvent<string, unknown> {
  return {
    __wskit: 'received',
    event,
    validator,
  };
}

/**
 * Check whether a value is a contract created by `received(...)`.
 */
export function isReceivedEvent(value: unknown): value is ReceivedEvent<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    '__wskit' in value &&
    value.__wskit === 'received' &&
    'event' in value
  );
}
