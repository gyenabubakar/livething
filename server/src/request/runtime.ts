/* oxlint-disable @typescript-eslint/no-explicit-any */
import { RequestNoCorrelation, RequestNoResponse } from '@wskit/core';
import { runWithScopedContext } from '~/intercept/runtime.ts';
import type { EngineAsyncContext } from '~/_engine/async-context.ts';
import type * as Protocol from '~/_engine/runtime/protocol.ts';
import type { ResolvedScope, RoutingTarget, RuntimeConnection } from '~/_engine/runtime/types.ts';
import type { RequestPrimitive } from './request.ts';

interface RequestRuntime {
  asyncContext: EngineAsyncContext;

  sendThroughPipeline(
    connection: RuntimeConnection,
    opts: { routing: RoutingTarget | undefined; event: string; payload: unknown },
  ): boolean;
}

export interface HandleRequestOptions {
  connection: RuntimeConnection;

  ctx: Record<PropertyKey, unknown>;

  scope: ResolvedScope;

  event: string;

  request: RequestPrimitive;

  payload: unknown;

  wskit: Protocol.WskitProtocol | undefined;
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
  options: HandleRequestOptions,
): Promise<void> {
  const { connection, scope, event, request, payload, wskit } = options;
  const correlationId = wskit?.correlationId;
  // Refuse to run the handler when no correlationId is on the wire — the
  // response could never settle a pending client promise, but any side
  // effects (broadcasts, plugin state writes, scheduled enqueues) inside
  // the handler would still happen.
  if (typeof correlationId !== 'string' || correlationId.length === 0) {
    throw RequestNoCorrelation();
  }
  let response: unknown;
  let responded = false;
  await runWithScopedContext(runtime, connection, {
    ctx: options.ctx,
    handler: (ctx) => {
      ctx.respond = (value: unknown) => {
        if (responded) {
          throw new Error('[wskit] ctx.respond() was already called for this request invocation.');
        }
        responded = true;
        response = value;
      };
      return request.handler(ctx, payload);
    },
  });

  // Handler exited without calling ctx.respond(). Surface this as a
  // correlated `__error__` so the client's pending request settles instead of
  // hanging until its own timeout. The outer dispatcher catches the throw and
  // routes it through handleRuntimeError, which carries the correlationId
  // from `wskit` back to the originating client promise.
  if (!responded) throw RequestNoResponse();

  runtime.sendThroughPipeline(connection, {
    routing: {
      namespace: scope.namespace?.name,
      channel: scope.channelName,
      channelScope: scope.channelScope,
      correlationId,
    },
    event,
    payload: response,
  });
}
