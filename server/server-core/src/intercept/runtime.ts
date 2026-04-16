/* oxlint-disable @typescript-eslint/no-explicit-any */
import { Skip } from '@wskit/core';
import type { ResolvedScope, RuntimeConnection } from '~/_engine/runtime/types.ts';
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
  setActiveConnectionId(id?: string): void;
}

/**
 * Build a scoped connection context and run a handler inside it.
 *
 * While the handler runs, the engine tracks which connection is "active" so
 * that context-aware helpers (like `ctx.ack()`) know who they are acting on.
 * The active connection is always cleared when the handler finishes, even if
 * it throws.
 */
export async function runWithScopedContext<T>(
  runtime: InterceptRuntime,
  connection: RuntimeConnection,
  scope: ResolvedScope,
  handler: (ctx: Record<PropertyKey, unknown>) => T | Promise<T>,
): Promise<T> {
  const ctx = runtime.buildConnectionContext(connection, scope);
  runtime.setActiveConnectionId(connection.id);

  try {
    return await handler(ctx);
  } finally {
    runtime.setActiveConnectionId(undefined);
  }
}

/**
 * Run every pre-validation intercept in registration order.
 *
 * Each intercept sees the message *before* schema validation. If an intercept
 * returns a new `{ event, payload }` object, that replacement is forwarded to
 * the next intercept and eventually to the validator. Returning nothing leaves
 * the message unchanged.
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
    try {
      const next = await runWithScopedContext(runtime, connection, scope, (ctx) => {
        return intercept.handler(ctx, nextMessage);
      });

      if (next) nextMessage = next;
    } catch (error) {
      if (error === Skip) continue;
      throw error;
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
