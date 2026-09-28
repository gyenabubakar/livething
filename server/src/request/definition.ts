/* oxlint-disable @typescript-eslint/no-explicit-any */
import { assertNonReservedEventName } from '~/event-name.ts';
import type { Validator } from '~/types.ts';

/**
 * Contract-side declaration of a request/response pair. Produced internally by
 * `base.request(...)`. The matching handler returns a value of the declared
 * response type to reply.
 */
export interface RequestDef<
  TName extends string = string,
  TPayload = unknown,
  TResponse = unknown,
> {
  readonly _: 'request';
  readonly name: TName;
  readonly payload?: Validator<TPayload>;
  readonly response?: Validator<TResponse>;
}

interface RequestDefinitionConfig<TPayload, TResponse> {
  payload?: Validator<TPayload>;
  response?: Validator<TResponse>;
}

/**
 * Declare a request/response pair. The handler returns a value matching the
 * declared response type to reply.
 */
export function request<TName extends string, TPayload = unknown, TResponse = unknown>(
  name: TName,
  config?: RequestDefinitionConfig<TPayload, TResponse>,
): RequestDef<TName, TPayload, TResponse> {
  assertNonReservedEventName(name, 'request');
  return { _: 'request', name, payload: config?.payload, response: config?.response };
}
