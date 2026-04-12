import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { Validator } from '~/types.ts';

export interface EventContract<TEvent extends string = string, TPayload = unknown> {
  readonly __wskit: 'event';
  readonly event: TEvent;
  readonly schema: Validator<TPayload>;
}

export function event<TEvent extends string, TPayload>(
  event: TEvent,
  schema: (value: unknown) => TPayload,
): EventContract<TEvent, TPayload>;
export function event<TEvent extends string, TSchema extends StandardSchemaV1>(
  event: TEvent,
  schema: TSchema,
): EventContract<TEvent, StandardSchemaV1.InferOutput<TSchema>>;
export function event(event: string, schema: Validator): EventContract {
  return {
    __wskit: 'event',
    event,
    schema,
  };
}
