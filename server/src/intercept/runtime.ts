/* oxlint-disable @typescript-eslint/no-explicit-any */
import { withConnectionContext } from '~/_engine/async-context.ts';
import type { ResolvedScope, RuntimeConnection } from '~/_engine/runtime/types.ts';
import type { AsyncContext } from '~/context.ts';
import type {
  InterceptMessage,
  PostInterceptPrimitive,
  PreInterceptPrimitive,
} from './intercept.ts';

interface InterceptRuntime {
  buildConnectionContext(
    connection: RuntimeConnection,
    scope?: ResolvedScope,
  ): Record<PropertyKey, unknown>;
  asyncContext?: AsyncContext;
}

/**
 * Build a scoped connection context and run a handler inside it.
 *
 * The handler runs inside the engine's async context, so context-aware
 * helpers a module calls (like `getState()`) resolve to this connection even
 * while handlers for other connections interleave.
 */
export async function runWithScopedContext<T>(
  runtime: InterceptRuntime,
  connection: RuntimeConnection,
  scope: ResolvedScope,
  handler: (ctx: Record<PropertyKey, unknown>) => T | Promise<T>,
): Promise<T> {
  const ctx = runtime.buildConnectionContext(connection, scope);
  return withConnectionContext(runtime.asyncContext, connection.id, () => handler(ctx));
}

/**
 * Run every pre-validation intercept in registration order.
 *
 * Each intercept sees the message *before* schema validation. The returned
 * value (when not `undefined`) becomes the new `payload` for the next
 * intercept and eventually for the validator. The event name is locked —
 * routing was resolved at dispatch entry and an intercept return of
 * `{ event, payload }` becomes the new payload as a whole, not a routing
 * instruction.
 *
 * Throwing inside an intercept stops the chain — the error propagates to the
 * engine's normal error handling (e.g. `Block`, `Skip`, typed errors).
 */
export async function runPreIntercepts(
  runtime: InterceptRuntime,
  connection: RuntimeConnection,
  scope: ResolvedScope,
  intercepts: readonly PreInterceptPrimitive[],
  message: InterceptMessage,
): Promise<InterceptMessage> {
  let nextMessage = message;

  for (const intercept of intercepts) {
    const next = await runWithScopedContext(runtime, connection, scope, (ctx) => {
      return intercept.handler(ctx, nextMessage);
    });

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
 * Returning a new value replaces the payload for the next intercept and
 * the final handler. Returning `undefined` keeps the current payload.
 *
 * Throwing inside an intercept stops the chain — the error propagates to the
 * engine's normal error handling.
 */
export async function runPostIntercepts(
  runtime: InterceptRuntime,
  connection: RuntimeConnection,
  scope: ResolvedScope,
  intercepts: readonly PostInterceptPrimitive[],
  payload: unknown,
): Promise<unknown> {
  let nextPayload = payload;

  for (const intercept of intercepts) {
    const next = await runWithScopedContext(runtime, connection, scope, (ctx) => {
      return intercept.handler(ctx, nextPayload);
    });

    if (next !== undefined) nextPayload = next;
  }

  return nextPayload;
}
