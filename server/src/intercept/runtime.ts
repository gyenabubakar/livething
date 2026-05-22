/* oxlint-disable @typescript-eslint/no-explicit-any */
import { withConnectionContext } from '~/_engine/async-context.ts';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';
import type { AsyncContext } from '~/context.ts';
import type {
  InterceptMessage,
  PostInterceptPrimitive,
  PreInterceptPrimitive,
} from './intercept.ts';

interface InterceptRuntime {
  asyncContext?: AsyncContext;
}

/** Returns the dispatch-shared connection context, building it on first call. */
type GetContext = () => Record<PropertyKey, unknown>;

/**
 * Run a handler inside the engine's async context for this connection.
 *
 * Context-aware helpers a module calls (like `getState()`) resolve to this
 * connection even while handlers for other connections interleave.
 */
export async function runWithScopedContext<T>(
  runtime: InterceptRuntime,
  connection: RuntimeConnection,
  ctx: Record<PropertyKey, unknown>,
  handler: (ctx: Record<PropertyKey, unknown>) => T | Promise<T>,
): Promise<T> {
  return withConnectionContext(runtime.asyncContext, connection.id, () => handler(ctx));
}

/**
 * Run every pre-validation intercept in registration order.
 *
 * Each intercept sees the message *before* schema validation. The returned
 * value (when not `undefined`) becomes the new `payload` for the next
 * intercept and eventually for the validator. The event name is locked.
 *
 * Throwing inside an intercept stops the chain — the error propagates to the
 * engine's normal error handling (e.g. `Block`, `Skip`, typed errors).
 */
export async function runPreIntercepts(
  runtime: InterceptRuntime,
  connection: RuntimeConnection,
  intercepts: readonly PreInterceptPrimitive[],
  message: InterceptMessage,
  getCtx: GetContext,
): Promise<InterceptMessage> {
  if (intercepts.length === 0) return message;

  const ctx = getCtx();
  let nextMessage = message;

  for (const intercept of intercepts) {
    const next = await withConnectionContext(runtime.asyncContext, connection.id, () =>
      intercept.handler(ctx, nextMessage),
    );

    if (next !== undefined) {
      nextMessage = { event: nextMessage.event, payload: next };
    }
  }

  return nextMessage;
}

/**
 * Run every post-validation intercept for one event in registration order.
 *
 * Each intercept sees the *validated* payload (not the raw wire message).
 * Returning a new value replaces the payload for the next intercept and the
 * final handler. Returning `undefined` keeps the current payload.
 *
 * Throwing inside an intercept stops the chain — the error propagates to the
 * engine's normal error handling.
 */
export async function runPostIntercepts(
  runtime: InterceptRuntime,
  connection: RuntimeConnection,
  intercepts: readonly PostInterceptPrimitive[],
  payload: unknown,
  getCtx: GetContext,
): Promise<unknown> {
  if (intercepts.length === 0) return payload;

  const ctx = getCtx();
  let nextPayload = payload;

  for (const intercept of intercepts) {
    const next = await withConnectionContext(runtime.asyncContext, connection.id, () =>
      intercept.handler(ctx, nextPayload),
    );

    if (next !== undefined) nextPayload = next;
  }

  return nextPayload;
}
