/* oxlint-disable @typescript-eslint/no-explicit-any */
import * as v from 'valibot';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { assertValidWSKitIdentifier } from './identifier.ts';
import { assertSyncResult } from './sync-guard.ts';

// ---------------------------------------------------------------------------
// Close codes
// ---------------------------------------------------------------------------

/**
 * WebSocket close codes used by WSKit. These tell the client *why* the
 * connection was closed — the client's reconnection logic reads them to
 * decide whether to retry.
 *
 * 1000–1015 are standard WebSocket codes. 4000–4999 are application-defined
 * (reserved for your app's own meanings). WSKit claims a handful of 4xxx
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
// WSKitError
// ---------------------------------------------------------------------------

/**
 * The error type for all WSKit application errors. Both server-thrown errors
 * and client-side errors (`Timeout`, `Disconnected`) are `WSKitError` instances.
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
export class WSKitError<TCode extends string = string, TDetail = unknown> extends Error {
  readonly code: TCode;
  readonly detail: TDetail;

  constructor(code: TCode, detail: TDetail) {
    super(`WSKitError: ${code}`);
    this.name = 'WSKitError';
    this.code = code;
    this.detail = detail;
  }
}

// ---------------------------------------------------------------------------
// ErrorDef — the thing `error()` returns
// ---------------------------------------------------------------------------

/** Internal shape of the validate closure: parse `unknown`, return the typed detail, or throw. */
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
   * Type guard that checks if an unknown value is a `WSKitError` with this
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
  matches(err: unknown): err is WSKitError<TCode, TDetail>;
}

/**
 * An error definition with a factory — created when `error()` receives a
 * detail schema. Call it to create a `WSKitError`:
 *
 * ```ts
 * import * as v from 'valibot';
 *
 * const Forbidden = error('forbidden', v.object({ reason: v.string() }));
 *
 * throw Forbidden({ reason: 'Not a member' }); // WSKitError<'forbidden', { reason: string }>
 * ```
 */
export interface ErrorDefWithFactory<TCode extends string, TDetail> extends ErrorDef<
  TCode,
  TDetail
> {
  (detail: TDetail): WSKitError<TCode, TDetail>;

  /**
   * The detail schema this error was created with, if any. Kept so the engine
   * can rebuild a copy of the error under a namespaced code (plugin errors are
   * re-emitted as `__pluginId:code`) without the caller re-supplying the
   * schema. Internal — product code never reads this.
   */
  readonly schema?: StandardSchemaV1;
}

// ---------------------------------------------------------------------------
// Internal: creates the `.matches()` type guard function
// ---------------------------------------------------------------------------

function createMatchesFn<TCode extends string, TDetail>(
  code: TCode,
  validate?: ValidateFn<TDetail>,
): (err: unknown) => err is WSKitError<TCode, TDetail> {
  return (err: unknown): err is WSKitError<TCode, TDetail> => {
    if (!(err instanceof WSKitError)) return false;
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
// These are signals to the WSKit engine — they're not sent to the client.
// Throw them from handlers, intercepts, or hooks to control message flow.
/**
 * Drop the current message silently. No error is sent to the client,
 * the handler never fires (or stops executing if thrown mid-handler).
 *
 * ```ts
 * implement(contract)
 *   .intercept((ctx, frame) => {
 *     if (isBanned(ctx.meta.userId)) throw Block;
 *   })
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
 * Two overloads:
 *
 * 1. **Code-only** — no detail payload:
 *    ```ts
 *    const NotFound = error('not-found');
 *    ```
 *
 * 2. **With a detail schema** — any Standard Schema (valibot, zod, arktype).
 *    The detail type is inferred from the schema, and the schema is also the
 *    runtime check `.matches()` runs:
 *    ```ts
 *    import * as v from 'valibot';
 *
 *    const RateLimited = error('rate-limited', v.object({ retryAfter: v.number() }));
 *    ```
 *
 * The schema overload returns a callable factory. Call it to create the error:
 * ```ts
 * throw RateLimited({ retryAfter: 30 });
 * ```
 */
export function error<TCode extends string>(code: TCode): ErrorDefWithFactory<TCode, void>;
export function error<TCode extends string, TSchema extends StandardSchemaV1>(
  code: TCode,
  schema: TSchema,
): ErrorDefWithFactory<TCode, StandardSchemaV1.InferOutput<TSchema>>;
export function error(code: string, schema?: StandardSchemaV1): ErrorDefWithFactory<string, any> {
  assertValidWSKitIdentifier(code, 'error code');
  return buildErrorFactory(code, schema);
}

/**
 * Build an error factory without checking the code against the identifier
 * rules. `error()` validates first and delegates here; `namespaceError()` uses
 * it to mint the engine-added `__pluginId:code` form (which is allowed to start
 * with `__` because the engine, not the developer, adds that prefix).
 */
function buildErrorFactory(
  code: string,
  schema?: StandardSchemaV1,
): ErrorDefWithFactory<string, any> {
  const validate: ValidateFn<any> | undefined = !schema
    ? undefined
    : (value: unknown) => {
        const result = assertSyncResult(schema['~standard'].validate(value), `error("${code}")`);
        if (result.issues) {
          throw new Error(
            `[wskit] Validation failed for error "${code}": ${result.issues[0]?.message}`,
          );
        }
        return result.value;
      };

  function factory(detail?: any) {
    return new WSKitError(code, validate ? validate(detail) : undefined);
  }
  factory.code = code;
  factory.schema = schema;
  factory.matches = createMatchesFn(code, validate);
  return factory as ErrorDefWithFactory<string, any>;
}

/**
 * Rebuild an error under a namespaced code, reusing the original's detail
 * schema. The engine calls this so a plugin's `error('denied')` is re-emitted
 * as `__acme:analytics:denied` — same detail validation, namespaced code so it
 * can't collide with a handler's own error of the same name.
 *
 * @internal Engine use only; not part of the public authoring surface.
 */
export function namespaceError(
  code: string,
  def: ErrorDefWithFactory<string, any>,
): ErrorDefWithFactory<string, any> {
  return buildErrorFactory(code, def.schema);
}

// ---------------------------------------------------------------------------
// Built-in error definitions
// ---------------------------------------------------------------------------

/**
 * Sent to the client when a message payload fails schema validation. You
 * don't need to define or register this error yourself — WSKit sends it
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
export const ValidationFailed = /* @__PURE__ */ error(
  'validation-failed',
  v.object({
    event: v.string(),
    issues: v.array(
      v.object({
        message: v.string(),
        path: v.optional(v.array(v.union([v.string(), v.number()]))),
      }),
    ),
  }),
);

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
export const ChannelNotFound = /* @__PURE__ */ error('channel-not-found');

/**
 * The error you get when you target a namespace the server doesn't
 * recognise. Usually a typo in the namespace name or a mismatch between
 * your client and server versions.
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
export const NamespaceNotFound = /* @__PURE__ */ error('namespace-not-found');

/**
 * The error you get when an incoming frame carries more than one scope
 * marker at once — for example both `__wskit.namespace` and
 * `__wskit.channel`. WSKit routes a frame to exactly one scope, so a
 * frame that names two scopes is ambiguous and the server rejects it
 * instead of silently picking one.
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
export const InvalidScopeMarkers = /* @__PURE__ */ error('invalid-scope-markers');

const UNSUPPORTED_PROTOCOL_EVENTS = v.picklist(['__replay__', '__resumeStream__']);

export type UnsupportedProtocolEvent = v.InferInput<typeof UNSUPPORTED_PROTOCOL_EVENTS>;

/**
 * Sent to the client when it uses a protocol feature the server doesn't
 * support. WSKit's client may send protocol frames like `__replay__` or
 * `__resumeStream__` on reconnect; if the server never enabled the matching
 * feature (no `replay`, or no durable streams because the adapter has no
 * storage), it replies with this code instead of silently ignoring the frame.
 * `detail.event` is the protocol event that was rejected.
 *
 * This almost always means a config mismatch: the client opted into a feature
 * the server didn't enable. Turn the feature on server-side, or drop the
 * matching client primitive.
 *
 * @example
 * ```ts
 * if (UnsupportedProtocol.matches(err)) {
 *   console.warn('server does not support', err.detail.event);
 * }
 * ```
 */
export const UnsupportedProtocol = /* @__PURE__ */ error(
  'unsupported-protocol',
  v.object({ event: UNSUPPORTED_PROTOCOL_EVENTS }),
);

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
export const ChannelNotSubscribed = /* @__PURE__ */ error('channel-not-subscribed');

/**
 * Sent to the client when the server rejects a persistent channel's auto-rejoin
 * on reconnect — the channel's `revalidate` hook threw. The durable membership
 * is dropped and this error is delivered scoped to the channel, so the client
 * knows the rejoin failed and clears the channel instead of staying stuck
 * "subscribed" to a membership the server no longer has.
 *
 * @example
 * ```ts
 * room.onSubscriptionFailed((err) => {
 *   if (RejoinRejected.matches(err)) showToast('You were removed from this room.');
 * });
 * ```
 */
export const RejoinRejected = /* @__PURE__ */ error(
  'rejoin-rejected',
  v.object({ message: v.string() }),
);

/**
 * Sent to the client when an unhandled server-side error occurs that WSKit
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
export const InternalError = /* @__PURE__ */ error('internal-error');

/**
 * Sent to the client when a `request(...)` handler returned without calling
 * `ctx.respond(...)`. The client's pending request promise rejects with this
 * code instead of hanging until its own timeout. The server-side cause is
 * almost always a missing `ctx.respond` on some code path inside the handler.
 *
 * @example
 * ```ts
 * try {
 *   await client.request('whoami', {});
 * } catch (err) {
 *   if (RequestNoResponse.matches(err)) {
 *     // server handler exited without ctx.respond — surface to logs / retry
 *   }
 * }
 * ```
 */
export const RequestNoResponse = /* @__PURE__ */ error('request-no-response');

/**
 * Sent to the client when a request frame arrived without a `correlationId`
 * on its `__wskit` envelope. The server refuses to run the handler because
 * the response could never be matched back to a pending client promise —
 * any side effects (broadcasts, plugin state writes, scheduled enqueues)
 * would happen with the client unable to learn the outcome.
 *
 * The client SDK stamps a `correlationId` automatically; this code only
 * fires for hand-crafted frames or non-SDK clients.
 */
export const RequestNoCorrelation = /* @__PURE__ */ error('request-no-correlation');

/**
 * Sent to the client when an in-flight stream terminates for a server-side
 * reason the client should react to. `detail.reason` describes why:
 *
 * - `'cancelled'` — the stream was cancelled (by `__streamCancel__` or server-side teardown).
 * - `'buffer-full'` — a durable (recorded) stream's chunk buffer hit its cap.
 *   The framework throws this into the generator's `yield` so handler code can
 *   catch and decide; if uncaught it surfaces on the wire.
 * - `'expired'` — a suspended durable stream aged out of its retention window before the client returned.
 * - `'not-found'` — a `__resumeStream__` request named a stream id the server doesn't recognise.
 * - `'hibernation-wake'` — a non-durable stream was lost because the server
 *   dropped in-memory state (e.g. Cloudflare Durable Object waking from
 *   hibernation). The wire-level connection is still alive; only the
 *   in-flight stream is gone.
 * - `'unsubscribed'` — the client previously sent `__streamCancel__` on this
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

const STREAM_ABORTED_REASONS = [
  'cancelled',
  'buffer-full',
  'expired',
  'not-found',
  'hibernation-wake',
  'unsubscribed',
  'cursor-invalid',
  'aborted',
] as const;

export const StreamAborted = /* @__PURE__ */ error(
  'stream-aborted',
  v.object({ reason: v.picklist(STREAM_ABORTED_REASONS) }),
);

/**
 * Sent to the client when a nudge can't be buffered because the stream's pending
 * nudge buffer is full (the generator is draining nudges slower than they
 * arrive). Unlike a `StreamAborted`, this is **non-terminal**: only the
 * offending `nudge()` rejects (with `__wskit.streamTerminated: false`), and the
 * stream keeps running — it is backpressure, not a teardown. `detail.cap` is the
 * buffer limit so the client can pace itself and retry.
 *
 * @example
 * ```ts
 * try {
 *   await stream.nudge('add-context', { context });
 * } catch (err) {
 *   if (NudgeOverflow.matches(err)) {
 *     // sending too fast — back off, the stream is still alive
 *   }
 * }
 * ```
 */
export const NudgeOverflow = /* @__PURE__ */ error('nudge-overflow', v.object({ cap: v.number() }));

/**
 * Sent to the client when a stream trigger frame carries a dev-supplied
 * `streamId` that is already in use by another active stream for the same
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
export const StreamIdCollision = /* @__PURE__ */ error('stream-id-collision');

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
 * try {
 *   await socket.request('send-message', { text });
 * } catch (err) {
 *   if (RateLimited.matches(err)) {
 *     setTimeout(retry, err.detail.retryAfter * 1000);
 *   }
 * }
 * ```
 */
export const RateLimited = /* @__PURE__ */ error(
  'rate-limited',
  v.object({ retryAfter: v.pipe(v.number(), v.finite(), v.minValue(0)) }),
);

/**
 * Sent to the client when it asks to start a stream of an event that already
 * has another stream of the same event running on the same connection. By
 * default a connection can only have one active stream per event name —
 * starting a second one is rejected with this code. The existing stream's
 * `streamId` is carried in `detail.streamId` so the client can decide
 * whether to wait for it, cancel it, or surface the conflict to the user.
 *
 * Opt out per-stream with `allowConcurrent: true` on the `stream()` definition
 * if the use case genuinely needs parallel runs of the same event (e.g. fan-out
 * searches).
 *
 * @example
 * ```ts
 * try {
 *   await socket.stream('start-tokens', { prompt: 'hi' });
 * } catch (err) {
 *   if (StreamAlreadyActive.matches(err)) {
 *     console.log('already running', err.detail.streamId);
 *   }
 * }
 * ```
 */
export const StreamAlreadyActive = /* @__PURE__ */ error(
  'stream-already-active',
  v.object({ event: v.string(), streamId: v.string() }),
);
