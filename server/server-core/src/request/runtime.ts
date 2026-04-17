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

/**
 * Extract the `_correlationId` field from an incoming payload.
 *
 * The client attaches this ID when sending a request so the engine can tag
 * the response with the same ID. The client then matches the response back
 * to the original `request()` Promise.
 */
export function readCorrelationId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object' || !('_correlationId' in payload)) return undefined;
  return String((payload as Record<string, unknown>)._correlationId);
}

/**
 * Execute a matched `.request(...)` handler and send the response back to the
 * client through the outgoing pipeline.
 *
 * A request handler typically calls `ctx.respond(value)`. This runtime helper
 * captures that value, then emits an outgoing event with the same name and
 * the original `_correlationId` so the client can resolve the correct Promise.
 */
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
  let response: unknown;
  await runWithScopedContext(runtime, connection, scope, (ctx) => {
    (ctx as Record<PropertyKey, unknown>).respond = (value: unknown) => {
      response = value;
    };
    return request.handler(ctx, payload);
  });

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
