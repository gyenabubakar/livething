/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { assertSyncResult } from './sync-guard.ts';

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

/**
 * A validation/parse function: takes unknown input, returns typed output, or
 * throws if the input is malformed.
 *
 * **The validator must do real work.** It's also the runtime check used by
 * `.matches()` — if the function just type-casts without inspecting the value,
 * `.matches()` effectively only checks the error code, and malformed details
 * will slip through both the factory and the guard.
 *
 * If you're absolutely certain the input is well-formed (e.g. a trusted
 * internal source), a type cast is acceptable as an explicit escape hatch —
 * but be aware that you're opting out of runtime safety.
 */
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
 *    The parse function must **actually validate** — checking fields and
 *    throwing on anything unexpected. This is wskit's zero-runtime-dep
 *    replacement for bringing in zod/valibot just for error shapes, and it
 *    doubles as the runtime check used by `.matches()`. If your function
 *    only type-casts (e.g. `(p) => p as { reason: string }`) then `.matches()`
 *    will return true for *any* `WskitError` with this code, regardless of
 *    whether `detail` actually has the expected shape — and the factory will
 *    happily produce malformed errors. Type-casting is only safe when you are
 *    absolutely certain the input is well-formed (e.g. a private, server-only
 *    control-flow error you construct yourself).
 *
 * 3. **StandardSchema** — detail type inferred from schema output (valibot, zod, arktype):
 *    ```ts
 *    const RateLimited = error('rate-limited', v.object({ retryAfter: v.number() }));
 *    ```
 *
 *    Schemas always validate, so this overload is the safest default.
 *
 * Overloads 2 and 3 return a callable factory. Call it to create the error:
 * ```ts
 * throw Forbidden({ reason: 'Not a member' });
 * ```
 */
export function error<TCode extends string>(code: TCode): ErrorDefWithFactory<TCode, void>;
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
): ErrorDefWithFactory<string, any> {
  const validate: ValidateFn<any> | undefined = !schemaOrParse
    ? undefined
    : typeof schemaOrParse === 'function'
      ? (value: unknown) => assertSyncResult(schemaOrParse(value), `error("${code}")`)
      : (value: unknown) => {
          const result = assertSyncResult(
            schemaOrParse['~standard'].validate(value),
            `error("${code}")`,
          );
          if (result.issues) {
            throw new Error(
              `[wskit] Validation failed for error "${code}": ${result.issues[0]?.message}`,
            );
          }
          return result.value;
        };

  function factory(detail?: any) {
    return new WskitError(code, validate ? validate(detail) : undefined);
  }
  factory.code = code;
  factory.matches = createMatchesFn(code, validate);
  return factory as ErrorDefWithFactory<string, any>;
}

// ---------------------------------------------------------------------------
// Built-in error definitions
// ---------------------------------------------------------------------------

/**
 * Sent to the client when a message payload fails schema validation. You
 * don't need to define or register this error yourself — wskit sends it
 * automatically whenever an incoming payload doesn't match its schema.
 *
 * @example
 * ```ts
 * // On the client:
 * if (ValidationFailed.matches(err)) {
 *   console.error('Bad payload for', err.detail.event, err.detail.issues);
 * }
 * ```
 *
 * Detail contains the event name and the Standard Schema issues array.
 */
export const ValidationFailed = error('validation-failed', (p: unknown) => {
  if (typeof p !== 'object' || p === null) {
    throw new Error('ValidationFailed detail must be an object');
  }
  const obj = p as Record<string, unknown>;
  if (typeof obj.event !== 'string') {
    throw new Error('ValidationFailed detail.event must be a string');
  }
  if (!Array.isArray(obj.issues)) {
    throw new Error('ValidationFailed detail.issues must be an array');
  }
  const issues: Array<{ message: string; path?: Array<string | number> }> = obj.issues.map(
    (issue, i) => {
      if (typeof issue !== 'object' || issue === null) {
        throw new Error(`ValidationFailed detail.issues[${i}] must be an object`);
      }
      const { message, path } = issue as Record<string, unknown>;
      if (typeof message !== 'string') {
        throw new Error(`ValidationFailed detail.issues[${i}].message must be a string`);
      }
      if (path === undefined) return { message };
      if (!Array.isArray(path)) {
        throw new Error(`ValidationFailed detail.issues[${i}].path must be an array`);
      }
      for (let j = 0; j < path.length; j++) {
        const part = path[j];
        if (typeof part !== 'string' && typeof part !== 'number') {
          throw new Error(
            `ValidationFailed detail.issues[${i}].path[${j}] must be a string or number`,
          );
        }
      }
      return { message, path: path as Array<string | number> };
    },
  );
  return { event: obj.event, issues };
});

/**
 * The error you get when you try to subscribe to a channel name the server
 * doesn't recognise — it isn't a declared static channel and doesn't match
 * any dynamic channel family. Usually means a typo in the channel name or a
 * mismatch between your client and server versions.
 *
 * @example
 * ```ts
 * try {
 *   await room.subscribe();
 * } catch (err) {
 *   if (ChannelNotFound.matches(err)) {
 *     showToast('That channel no longer exists.');
 *   }
 * }
 * ```
 */
export const ChannelNotFound = error('channel-not-found');

/**
 * The error you get when you target a namespace the server doesn't
 * recognise. Usually a typo in `_namespace` or a mismatch between your
 * client and server versions.
 *
 * @example
 * ```ts
 * try {
 *   await client.namespace('amdin').do('something');
 * } catch (err) {
 *   if (NamespaceNotFound.matches(err)) {
 *     showToast('Unknown namespace.');
 *   }
 * }
 * ```
 */
export const NamespaceNotFound = error('namespace-not-found');

/**
 * The error you get when an incoming frame carries more than one scope
 * marker at once — for example both `_namespace` and `_channel`. wskit
 * routes a frame to exactly one scope, so a frame that names two scopes
 * is ambiguous and the server rejects it instead of silently picking
 * one.
 *
 * @example
 * ```ts
 * try {
 *   await client.namespace('admin').do('something');
 * } catch (err) {
 *   if (InvalidScopeMarkers.matches(err)) {
 *     // a client-side bug attached two scope markers to the same frame
 *   }
 * }
 * ```
 */
export const InvalidScopeMarkers = error('invalid-scope-markers');

/**
 * Thrown when a client sends a message to a channel it isn't subscribed to,
 * or tries to unsubscribe from a channel it never joined.
 *
 * @example
 * ```ts
 * try {
 *   await room.unsubscribe();
 * } catch (err) {
 *   if (ChannelNotSubscribed.matches(err)) {
 *     // already left, safe to ignore
 *   }
 * }
 * ```
 */
export const ChannelNotSubscribed = error('channel-not-subscribed');

/**
 * Sent to the client when an unhandled server-side error occurs that wskit
 * doesn't know how to classify. The server logs the real error; the client
 * receives this opaque code so internal details are never leaked.
 *
 * @example
 * ```ts
 * if (InternalError.matches(err)) {
 *   showToast('Something went wrong. Please try again.');
 * }
 * ```
 */
export const InternalError = error('internal-error');

/**
 * Sent to the client when an in-flight stream terminates for a server-side
 * reason the client should react to. `detail.reason` describes why:
 *
 * - `'cancelled'` — the stream was cancelled (by `_streamCancel` or server-side teardown).
 * - `'buffer-full'` — a durable (recorded) stream's chunk buffer hit its cap.
 *   The framework throws this into the generator's `yield` so handler code can
 *   catch and decide; if uncaught it surfaces on the wire.
 * - `'expired'` — a suspended durable stream aged out of its retention window before the client returned.
 * - `'not-found'` — a `_resumeStream` request named a stream id the server doesn't recognise.
 * - `'hibernation-wake'` — a non-durable stream was lost because the server
 *   dropped in-memory state (e.g. Cloudflare Durable Object waking from
 *   hibernation). The wire-level connection is still alive; only the
 *   in-flight stream is gone.
 * - `'unsubscribed'` — the client previously sent `_streamCancel` on this
 *   broadcast stream's id, so the server has stopped fanning chunks to that
 *   identity. The stream itself stays running for everyone else.
 * - `'cursor-invalid'` — on resume, the stored cursor failed the validator
 *   declared on the `resumableStream`. The row stays in place; the resuming
 *   client gets this signal so it can pick a recovery strategy (drop the
 *   stream, start fresh, surface the bug).
 * - `'aborted'` — catch-all when the framework had to tear the stream down
 *   for an internal reason that does not match any of the above.
 *
 * Distinct from `InternalError` so a client SDK can fast-resume the affected
 * streams (with backoff) instead of treating the signal as a server crash.
 *
 * @example
 * ```ts
 * try {
 *   for await (const chunk of stream) { ... }
 * } catch (err) {
 *   if (StreamAborted.matches(err)) {
 *     if (err.detail.reason === 'hibernation-wake') restartStream();
 *     else if (err.detail.reason === 'buffer-full')  showSlowDownToast();
 *   }
 * }
 * ```
 */
export type StreamAbortedReason =
  | 'cancelled'
  | 'buffer-full'
  | 'expired'
  | 'not-found'
  | 'hibernation-wake'
  | 'unsubscribed'
  | 'cursor-invalid'
  | 'aborted';

const STREAM_ABORTED_REASONS: readonly StreamAbortedReason[] = [
  'cancelled',
  'buffer-full',
  'expired',
  'not-found',
  'hibernation-wake',
  'unsubscribed',
  'cursor-invalid',
  'aborted',
];

export const StreamAborted = error('stream-aborted', (p: unknown) => {
  if (typeof p !== 'object' || p === null) {
    throw new Error('StreamAborted detail must be an object');
  }
  const obj = p as Record<string, unknown>;
  const reason = obj.reason;
  if (
    typeof reason !== 'string' ||
    !(STREAM_ABORTED_REASONS as readonly string[]).includes(reason)
  ) {
    throw new Error(
      `StreamAborted detail.reason must be one of: ${STREAM_ABORTED_REASONS.join(', ')}`,
    );
  }
  return { reason: reason as StreamAbortedReason };
});

/**
 * Sent to the client when a stream trigger frame carries a dev-supplied
 * `_streamId` that is already in use by another active stream for the same
 * connection identity. The client must pick a different id or wait for the
 * existing stream to end.
 *
 * @example
 * ```ts
 * try {
 *   await socket.stream('start-tokens', { prompt }, { streamId: convoId });
 * } catch (err) {
 *   if (StreamIdCollision.matches(err)) {
 *     showError('This conversation already has an active stream.');
 *   }
 * }
 * ```
 */
export const StreamIdCollision = error('stream-id-collision');

/**
 * Sent to the client when an incoming frame is rejected because the connection
 * is sending faster than the configured rate-limit cap for the scope the frame
 * landed in. The handler does not run; the validator does not run. The client
 * can read `detail.retryAfter` (seconds until the next slot opens) and back off.
 *
 * If a connection blows past the cap by a large factor the framework may close
 * the socket with `CloseCodes.RATE_LIMITED` (4005) instead — that is a separate
 * decision from this per-frame rejection.
 *
 * @example
 * ```ts
 * socket.on('_error', (err) => {
 *   if (RateLimited.matches(err)) {
 *     setTimeout(retry, err.detail.retryAfter * 1000);
 *   }
 * });
 * ```
 */
export const RateLimited = error('rate-limited', (p: unknown) => {
  if (typeof p !== 'object' || p === null) {
    throw new Error('RateLimited detail must be an object');
  }
  const obj = p as Record<string, unknown>;
  if (
    typeof obj.retryAfter !== 'number' ||
    !Number.isFinite(obj.retryAfter) ||
    obj.retryAfter < 0
  ) {
    throw new Error('RateLimited detail.retryAfter must be a non-negative finite number');
  }
  return { retryAfter: obj.retryAfter };
});

/**
 * Sent to the client when it asks to start a stream of an event that already
 * has another stream of the same event running on the same connection. By
 * default a connection can only have one active stream per event name —
 * starting a second one is rejected with this code. The existing stream's
 * `_streamId` is carried in `detail._streamId` so the client can decide
 * whether to wait for it, cancel it, or surface the conflict to the user.
 *
 * Opt out per-stream with `.allowConcurrent()` on the stream builder if the
 * use case genuinely needs parallel runs of the same event (e.g. fan-out
 * searches).
 *
 * @example
 * ```ts
 * try {
 *   await socket.stream('start-tokens', { prompt: 'hi' });
 * } catch (err) {
 *   if (StreamAlreadyActive.matches(err)) {
 *     console.log('already running', err.detail._streamId);
 *   }
 * }
 * ```
 */
export const StreamAlreadyActive = error('stream-already-active', (p: unknown) => {
  if (typeof p !== 'object' || p === null) {
    throw new Error('StreamAlreadyActive detail must be an object');
  }
  const obj = p as Record<string, unknown>;
  if (typeof obj.event !== 'string') {
    throw new Error('StreamAlreadyActive detail.event must be a string');
  }
  if (typeof obj._streamId !== 'string') {
    throw new Error('StreamAlreadyActive detail._streamId must be a string');
  }
  return { event: obj.event, _streamId: obj._streamId };
});
