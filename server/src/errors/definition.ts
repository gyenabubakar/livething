/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { Validator } from '~/types.ts';

/**
 * Contract-side declaration of a typed error code. Produced by the runtime
 * `error()` factory from `@wskit/core` and listed in a contract's `errors: [...]`
 * array. Surfaces the code and detail shape to client SDKs through `InferClient`.
 */
export interface ErrorContractDef<TCode extends string = string, TDetail = unknown> {
  readonly _: 'error';
  readonly code: TCode;
  readonly schema?: Validator<TDetail>;
}
