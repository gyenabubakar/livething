/* oxlint-disable @typescript-eslint/no-explicit-any */
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

    if (next) nextMessage = next;
  }

  return nextMessage;
}

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
