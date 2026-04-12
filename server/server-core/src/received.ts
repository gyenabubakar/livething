import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { Validator } from '~/types.ts';

/**
 * @internal — will be replaced by event(name, schema) in the builder pattern rewrite.
 */
export interface ReceivedEvent<TEvent extends string = string, TPayload = unknown> {
  readonly __wskit: 'received';
  readonly event: TEvent;
  readonly validator?: Validator<TPayload>;
}

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

export function isReceivedEvent(value: unknown): value is ReceivedEvent<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    '__wskit' in value &&
    value.__wskit === 'received' &&
    'event' in value
  );
}
