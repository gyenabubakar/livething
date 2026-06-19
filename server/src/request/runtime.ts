/* oxlint-disable @typescript-eslint/no-explicit-any */
import { RequestNoCorrelation, RequestNoResponse } from '@wskit/core';
import { runWithScopedContext } from '~/intercept/runtime.ts';
import type { EngineAsyncContext } from '~/_engine/async-context.ts';
import type * as Protocol from '~/_engine/runtime/protocol.ts';
import type { ResolvedScope, RoutingTarget, RuntimeConnection } from '~/_engine/runtime/types.ts';
import type { Logger } from '~/context.ts';
import type { RequestPrimitive } from './request.ts';

interface RequestRuntime {
  asyncContext: EngineAsyncContext;

  logger: Pick<Logger, 'error'>;

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

  wskit: Protocol.WSKitProtocol | undefined;
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
  // the handler would still happen. The wire schema bounds and non-empties it
  // (`WireId`), so absent is the only failure mode left.
  if (correlationId === undefined) {
    throw RequestNoCorrelation();
  }

  let response: unknown;
  let responded = false;

  await runWithScopedContext(runtime, connection, {
    ctx: options.ctx,
    handler: (ctx) => {
      ctx.respond = (value: unknown) => {
        if (responded) {
          // Calling respond() twice is a server-side programming mistake, not
          // something the client did. The first response already settled the
          // client's promise, so swallow the extra call and log it instead of
          // throwing — a throw here would surface a spurious `internal-error`
          // to a client that already got its answer.
          runtime.logger.error(
            '[wskit] ctx.respond() was already called for this request invocation; ignoring the extra call',
            { event },
          );
          return;
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
      channel: scope.channelName,
      channelScope: scope.channelScope,
      correlationId,
      // The client originated this request; this is the reply to it.
      source: 'client',
    },
    event,
    payload: response,
  });
}
