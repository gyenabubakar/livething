/* oxlint-disable @typescript-eslint/no-explicit-any */
import { assertNonReservedEventName } from '~/_engine/compile/utils.ts';
import type { Validator } from '~/types.ts';

/**
 * Contract-side declaration of a request/response pair. Produced by `request()`.
 * The matching handler calls `ctx.respond()` with a value of the declared
 * response type.
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

/**
 * Declare a request/response pair. The handler calls `ctx.respond()` with a
 * value matching the declared response schema.
 */
export function request<TName extends string, TPayload = unknown, TResponse = unknown>(
  name: TName,
  config?: { payload?: Validator<TPayload>; response?: Validator<TResponse> },
): RequestDef<TName, TPayload, TResponse> {
  assertNonReservedEventName(name, 'request');
  return { _: 'request', name, payload: config?.payload, response: config?.response };
}
