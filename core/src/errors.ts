/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { StandardSchemaV1 } from '@standard-schema/spec';

// ---------------------------------------------------------------------------
// Close codes
// ---------------------------------------------------------------------------

/**
 * WebSocket close codes used by wskit. These tell the client *why* the
 * connection was closed — the client's reconnection logic reads them to
 * decide whether to retry.
 *
 * 1000–1015 are standard WebSocket codes. 4000–4999 are application-defined
 * (reserved for your app's own meanings). wskit claims a handful of 4xxx
 * codes for common scenarios.
 *
 * ```ts
 * import { CloseCodes } from '@wskit/core';
 *
 * ctx.close(CloseCodes.BANNED, 'You have been banned');
 * ```
 */
export const CloseCodes = Object.freeze({
  /** Normal closure — the connection completed its purpose. */
  NORMAL: 1000,
  /** Server going away — restart, deploy, or shutdown. Clients should reconnect. */
  GOING_AWAY: 1001,
  /** Authentication token expired. Client should refresh and reconnect. */
  AUTH_EXPIRED: 4001,
  /** Authentication token invalid. Don't reconnect with the same token. */
  AUTH_INVALID: 4002,
  /** Duplicate connection — another connection for the same user replaced this one. */
  DUPLICATE: 4003,
  /** Idle timeout — no activity for too long. Keepalive missed pongs trigger this. */
  IDLE: 4004,
  /** Rate limited — sending messages too fast. Back off before reconnecting. */
  RATE_LIMITED: 4005,
  /** Banned — user is permanently blocked. Do not reconnect. */
  BANNED: 4009,
  /** Server at capacity — too many connections. Retry with backoff. */
  CAPACITY: 4010,
});

// ---------------------------------------------------------------------------
// WskitError
// ---------------------------------------------------------------------------

/**
 * The error type for all wskit application errors. Both server-thrown errors
 * and client-side errors (`Timeout`, `Disconnected`) are `WskitError` instances.
 *
 * - `code` — a lowercase-kebab string identifying the error (e.g. `'forbidden'`)
 * - `detail` — typed payload with extra information (e.g. `{ reason: string }`)
 *
 * Use `ErrorDef.matches()` to narrow an unknown error to a specific code and detail type.
 *
 * ```ts
 * try {
 *   await socket.request('create-post', data);
 * } catch (err) {
 *   if (Forbidden.matches(err)) {
 *     console.log(err.detail.reason); // string — fully typed
 *   }
 * }
 * ```
 */
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

// ---------------------------------------------------------------------------
// ErrorDef — the thing `error()` returns
// ---------------------------------------------------------------------------

/** A validation/parse function: takes unknown input, returns typed output or throws. */
type ValidateFn<TDetail> = (value: unknown) => TDetail;

/**
 * An error definition. Created by `error()`. Carries the error code and a
 * `.matches()` type guard for narrowing unknown errors.
 *
 * Code-only errors (no detail) are plain objects — not callable.
 * Errors with a validator are callable factories (see `ErrorDefWithFactory`).
 */
export interface ErrorDef<TCode extends string = string, TDetail = void> {
  readonly code: TCode;

  /**
   * Type guard that checks if an unknown value is a `WskitError` with this
   * error's code. If the error was created with a validator, `.matches()` also
   * runs the validator on the detail to confirm the shape is correct.
   *
   * ```ts
   * if (Forbidden.matches(err)) {
   *   err.code;          // 'forbidden'
   *   err.detail.reason; // string — validated at runtime
   * }
   * ```
   */
  matches(err: unknown): err is WskitError<TCode, TDetail>;
}

/**
 * An error definition with a factory — created when `error()` receives a
 * validator (parse function or StandardSchema). Call it to create a `WskitError`:
 *
 * ```ts
 * const Forbidden = error('forbidden', (p) => {
 *   const obj = p as Record<string, unknown>;
 *   if (typeof obj.reason !== 'string') throw new Error('reason required');
 *   return { reason: obj.reason };
 * });
 *
 * throw Forbidden({ reason: 'Not a member' }); // WskitError<'forbidden', { reason: string }>
 * ```
 */
export interface ErrorDefWithFactory<TCode extends string, TDetail> extends ErrorDef<
  TCode,
  TDetail
> {
  (detail: TDetail): WskitError<TCode, TDetail>;
}

// ---------------------------------------------------------------------------
// Internal: creates the `.matches()` type guard function
// ---------------------------------------------------------------------------

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
// Control flow errors
// ---------------------------------------------------------------------------
//
// These are signals to the wskit engine — they're not sent to the client.
// Throw them from handlers, intercepts, or hooks to control message flow.
// Both server and client share Block and Skip.

/**
 * Drop the current message silently. No error is sent to the client,
 * the handler never fires (or stops executing if thrown mid-handler).
 *
 * ```ts
 * intercept(async (ctx, message) => {
 *   if (isBanned(ctx.meta.userId)) throw Block;
 *   return message;
 * });
 * ```
 */
export const Block = Object.freeze({ __wskit: 'block' as const });

/**
 * Skip this primitive or module's processing, but continue to the next one.
 * Unlike `Block` (which kills the whole pipeline), `Skip` says "I don't
 * care about this message, let others handle it."
 *
 * ```ts
 * hooks.onIncoming((message) => {
 *   if (message.event !== 'my-event') throw Skip;
 * });
 * ```
 */
export const Skip = Object.freeze({ __wskit: 'skip' as const });

// ---------------------------------------------------------------------------
// error() — define application errors
// ---------------------------------------------------------------------------

/**
 * Define a typed application error. Shared between server and client — define
 * your errors once in a shared file, import them on both sides.
 *
 * Three overloads:
 *
 * 1. **Code-only** — no detail payload:
 *    ```ts
 *    const NotFound = error('not-found');
 *    ```
 *
 * 2. **Parse function** — detail type inferred from return value:
 *    ```ts
 *    const Forbidden = error('forbidden', (p) => {
 *      const obj = p as Record<string, unknown>;
 *      if (typeof obj.reason !== 'string') throw new Error('reason required');
 *      return { reason: obj.reason };
 *    });
 *    ```
 *
 * 3. **StandardSchema** — detail type inferred from schema output (valibot, zod, arktype):
 *    ```ts
 *    const RateLimited = error('rate-limited', v.object({ retryAfter: v.number() }));
 *    ```
 *
 * Overloads 2 and 3 return a callable factory. Call it to create the error:
 * ```ts
 * throw Forbidden({ reason: 'Not a member' });
 * ```
 */
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
// Built-in error definitions
// ---------------------------------------------------------------------------

/**
 * Thrown by the engine when a message fails schema validation. Auto-registered —
 * you never need to add this to `errors()`. Always present in `InferClientType.__errors__`.
 *
 * Detail contains the event name and the Standard Schema issues array.
 */
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
