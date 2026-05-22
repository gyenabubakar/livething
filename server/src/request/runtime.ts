/* oxlint-disable @typescript-eslint/no-explicit-any */
import { runWithScopedContext } from '~/intercept/runtime.ts';
import type * as Protocol from '~/_engine/runtime/protocol.ts';
import type { ResolvedScope, RoutingTarget, RuntimeConnection } from '~/_engine/runtime/types.ts';
import type { AsyncContext } from '~/context.ts';
import type { RequestPrimitive } from './request.ts';

interface RequestRuntime {
  buildConnectionContext(
    connection: RuntimeConnection,
    scope?: ResolvedScope,
  ): Record<PropertyKey, unknown>;
  asyncContext?: AsyncContext;
  sendThroughPipeline(
    connection: RuntimeConnection,
    routing: RoutingTarget | undefined,
    event: string,
    payload: unknown,
  ): boolean;
}

/**
 * Execute a matched `.request(...)` handler and send the response back to the
 * client through the outgoing pipeline.
 *
 * A request handler typically calls `ctx.respond(value)`. This runtime helper
 * captures that value, then emits an outgoing event with the same name and the
 * original `correlationId` (read from the incoming frame's `__wskit`) so the
 * client can resolve the correct Promise.
 */
export async function handleRequest(
  runtime: RequestRuntime,
  connection: RuntimeConnection,
  scope: ResolvedScope,
  event: string,
  request: RequestPrimitive,
  payload: unknown,
  wskit: Protocol.WskitProtocol | undefined,
): Promise<void> {
  const correlationId = wskit?.correlationId;
  let response: unknown;
  let responded = false;
  await runWithScopedContext(
    runtime,
    connection,
    runtime.buildConnectionContext(connection, scope),
    (ctx) => {
      (ctx as Record<PropertyKey, unknown>).respond = (value: unknown) => {
        if (responded) {
          throw new Error('[wskit] ctx.respond() was already called for this request invocation.');
        }
        responded = true;
        response = value;
      };
      return request.handler(ctx, payload);
    },
  );

  // Handler that never called ctx.respond() — leave the request hanging on
  // the client side. Pushing `undefined` through the pipeline would fail the
  // payload-must-be-an-object check and surface as a spurious internal error.
  if (!responded) return;

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
