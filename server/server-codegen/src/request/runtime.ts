/* oxlint-disable @typescript-eslint/no-explicit-any */
import { runWithScopedContext } from '~/intercept/runtime.ts';
import type { ResolvedScope, RoutingTarget, RuntimeConnection } from '~/_engine/runtime/types.ts';
import type { RequestPrimitive } from './request.ts';

interface RequestRuntime {
  buildConnectionContext(
    connection: RuntimeConnection,
    scope?: ResolvedScope,
  ): Record<PropertyKey, unknown>;
  setActiveConnectionId(id?: string): void;
  sendThroughPipeline(
    connection: RuntimeConnection,
    routing: RoutingTarget | undefined,
    event: string,
    payload: unknown,
  ): boolean;
}

export function readCorrelationId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object' || !('_correlationId' in payload)) return undefined;
  return String((payload as Record<string, unknown>)._correlationId);
}

export async function handleRequest(
  runtime: RequestRuntime,
  connection: RuntimeConnection,
  scope: ResolvedScope,
  event: string,
  request: RequestPrimitive,
  payload: unknown,
  rawPayload: unknown,
): Promise<void> {
  const correlationId = readCorrelationId(rawPayload);
  const response = await runWithScopedContext(runtime, connection, scope, (ctx) =>
    request.handler(ctx, payload),
  );

  runtime.sendThroughPipeline(
    connection,
    {
      namespace: scope.namespace?.name,
      channel: scope.channelName,
      channelScope: scope.channelScope,
      correlationId,
    },
    event,
    response,
  );
}
