/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { StandardSchemaV1 } from '@standard-schema/spec';

export const CloseCodes = Object.freeze({
  NORMAL: 1000,
  GOING_AWAY: 1001,
  AUTH_EXPIRED: 4001,
  AUTH_INVALID: 4002,
  DUPLICATE: 4003,
  IDLE: 4004,
  RATE_LIMITED: 4005,
  BANNED: 4009,
  CAPACITY: 4010,
});

export class WskitError<TCode extends string = string, TDetail = unknown> extends Error {
  readonly code: TCode;
  readonly detail: TDetail;

  constructor(code: TCode, detail: TDetail) {
    super(`WskitError: ${code}`);
    this.name = 'WskitError';
    this.code = code;
    this.detail = detail;
  }
}

type ValidateFn<TDetail> = (value: unknown) => TDetail;

export interface ErrorDef<TCode extends string = string, TDetail = void> {
  readonly code: TCode;
  matches(err: unknown): err is WskitError<TCode, TDetail>;
}

export interface ErrorDefWithFactory<TCode extends string, TDetail> extends ErrorDef<
  TCode,
  TDetail
> {
  (detail: TDetail): WskitError<TCode, TDetail>;
}

function createMatchesFn<TCode extends string, TDetail>(
  code: TCode,
  validate?: ValidateFn<TDetail>,
): (err: unknown) => err is WskitError<TCode, TDetail> {
  return (err: unknown): err is WskitError<TCode, TDetail> => {
    if (!(err instanceof WskitError)) return false;
    if (err.code !== code) return false;
    if (!validate) return true;
    try {
      validate(err.detail);
      return true;
    } catch {
      return false;
    }
  };
}

// ---------------------------------------------------------------------------
// Control flow errors (shared by server and client)
// ---------------------------------------------------------------------------

export const Block = Object.freeze({ __wskit: 'block' as const });
export const Skip = Object.freeze({ __wskit: 'skip' as const });

// ---------------------------------------------------------------------------
// error() factory
// ---------------------------------------------------------------------------

export function error<TCode extends string>(code: TCode): ErrorDef<TCode, void>;
export function error<TCode extends string, TDetail>(
  code: TCode,
  parse: ValidateFn<TDetail>,
): ErrorDefWithFactory<TCode, TDetail>;
export function error<TCode extends string, TSchema extends StandardSchemaV1>(
  code: TCode,
  schema: TSchema,
): ErrorDefWithFactory<TCode, StandardSchemaV1.InferOutput<TSchema>>;
export function error(
  code: string,
  schemaOrParse?: StandardSchemaV1 | ValidateFn<any>,
): ErrorDef | ErrorDefWithFactory<string, any> {
  if (!schemaOrParse) {
    return {
      code,
      matches: createMatchesFn(code),
    };
  }

  const validate: ValidateFn<any> =
    typeof schemaOrParse === 'function'
      ? schemaOrParse
      : (value: unknown) => {
          const result = schemaOrParse['~standard'].validate(value);
          if (result instanceof Promise) {
            throw new Error(
              `[wskit] error() does not support async validators. Use a sync schema or parse function for "${code}".`,
            );
          }
          if (result.issues) {
            throw new Error(
              `[wskit] Validation failed for error "${code}": ${result.issues[0]?.message}`,
            );
          }
          return result.value;
        };

  function factory(detail: any) {
    return new WskitError(code, validate(detail));
  }
  factory.code = code;
  factory.matches = createMatchesFn(code, validate);
  return factory as ErrorDefWithFactory<string, any>;
}

// ---------------------------------------------------------------------------
// Built-in error definitions (shared by server and client)
// ---------------------------------------------------------------------------

export const ValidationFailed = error('validation-failed', (p: unknown) => {
  const obj = p as Record<string, unknown>;
  return {
    event: String(obj.event),
    issues: obj.issues as Array<{
      message: string;
      path?: Array<string | number>;
    }>,
  };
});
