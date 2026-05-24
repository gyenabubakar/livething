/* oxlint-disable @typescript-eslint/no-explicit-any */
import { withConnectionContext } from '~/_engine/async-context.ts';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';
import type { AsyncContext } from '~/context.ts';
import type { InterceptFrame, InterceptPrimitive } from './intercept.ts';

export type { InterceptFrame, InterceptRouting } from './intercept.ts';

interface InterceptRuntime {
  asyncContext?: AsyncContext;
}

/** Returns the dispatch-shared connection context, building it on first call. */
type GetContext = () => Record<PropertyKey, unknown>;

export interface RunWithScopedContextOptions<T> {
  ctx: Record<PropertyKey, unknown>;

  handler: (ctx: Record<PropertyKey, unknown>) => T | Promise<T>;
}

/**
 * Run a handler inside the engine's async context for this connection.
 *
 * Context-aware helpers a plugin calls (like `getState()`) resolve to this
 * connection even while handlers for other connections interleave.
 */
export async function runWithScopedContext<T>(
  runtime: InterceptRuntime,
  connection: RuntimeConnection,
  options: RunWithScopedContextOptions<T>,
): Promise<T> {
  const { ctx, handler } = options;
  return withConnectionContext(runtime.asyncContext, connection.id, () => handler(ctx));
}

export interface RunInterceptsOptions {
  intercepts: readonly InterceptPrimitive[];

  frame: InterceptFrame;

  getCtx: GetContext;
}

/**
 * Run every intercept in registration order.
 *
 * Each intercept sees the frame *before* schema validation. The returned value
 * (when not `undefined`) becomes the new `payload` for the next intercept and
 * eventually for the validator. The event name and routing are locked.
 *
 * Throwing inside an intercept stops the chain — the error propagates to the
 * engine's normal error handling (e.g. `Block`, `Skip`, typed errors).
 */
export async function runIntercepts(
  runtime: InterceptRuntime,
  connection: RuntimeConnection,
  options: RunInterceptsOptions,
): Promise<InterceptFrame> {
  const { intercepts, frame, getCtx } = options;
  if (intercepts.length === 0) return frame;

  const ctx = getCtx();
  let nextFrame = frame;

  for (const intercept of intercepts) {
    const next = await withConnectionContext(runtime.asyncContext, connection.id, () =>
      intercept.handler(ctx, nextFrame),
    );

    if (next !== undefined) {
      nextFrame = {
        event: nextFrame.event,
        payload: next,
        kind: nextFrame.kind,
        routing: nextFrame.routing,
      };
    }
  }

  return nextFrame;
}
