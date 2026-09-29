/* oxlint-disable @typescript-eslint/no-explicit-any */
import { RequestNoCorrelation } from '@livething/core';
import { connectionCall, withConnectionCall } from '~/_engine/async-context.ts';
import type { EngineAsyncContext } from '~/_engine/async-context.ts';
import type * as Protocol from '~/_engine/runtime/protocol.ts';
import type { ResolvedChannel, RoutingTarget, RuntimeConnection } from '~/_engine/runtime/types.ts';
import type { Logger } from '~/context.ts';
import type { RequestPrimitive } from './request.ts';

type OptsParameter = { routing: RoutingTarget | undefined; event: string; payload: unknown };

interface RequestRuntime {
  asyncContext: EngineAsyncContext;

  logger: Pick<Logger, 'error'>;

  sendThroughPipeline(connection: RuntimeConnection, opts: OptsParameter): boolean;
}

export interface HandleRequestOptions {
  connection: RuntimeConnection;

  ctx: Record<PropertyKey, unknown>;

  scope: ResolvedChannel;

  event: string;

  request: RequestPrimitive;

  payload: unknown;

  livething: Protocol.LiveThingProtocol | undefined;
}

/**
 * Execute a matched `.request(...)` handler and send the response back to the
 * client through the outgoing pipeline.
 *
 * A request handler typically calls `ctx.respond(value)`. This runtime helper
 * captures that value, then emits an outgoing event with the same name and the
 * original `correlationId` (read from the incoming frame's `__livething`) so the
 * client can resolve the correct Promise.
 *
 * A handler that finishes without a real answer — it returned nothing, `null`,
 * or `undefined`, or never called `ctx.respond` — settles the client as a void
 * acknowledgement: an empty correlated frame the client resolves with no value.
 * To reject the client instead, throw (a declared error carries its code and
 * detail; anything else collapses to `internal-error`).
 */
export async function handleRequest(
  runtime: RequestRuntime,
  options: HandleRequestOptions,
): Promise<void> {
  const { connection, scope, event, request, payload, livething } = options;
  const correlationId = livething?.correlationId;

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

  await withConnectionCall(
    runtime.asyncContext,
    connectionCall(connection.id, scope, () => options.ctx),
    () => {
      const ctx = options.ctx;
      ctx.respond = (value: unknown) => {
        if (responded) {
          // Calling respond() twice is a server-side programming mistake, not
          // something the client did. The first response already settled the
          // client's promise, so swallow the extra call and log it instead of
          // throwing — a throw here would surface a spurious `internal-error`
          // to a client that already got its answer.
          runtime.logger.error(
            '[livething] ctx.respond() was already called for this request invocation; ignoring the extra call',
            { event },
          );
          return;
        }

        responded = true;
        response = value;
      };

      return request.handler(ctx, payload);
    },
  );

  runtime.sendThroughPipeline(connection, {
    routing: {
      channel: scope.channelName,
      channelFamily: scope.channelFamily,
      correlationId,
      // The client originated this request; this is the reply to it.
      source: 'client',
    },
    event,
    // A nullish answer (no response, or a `null`/`undefined` one) is a void
    // acknowledgement: send an undefined payload so the client resolves with
    // no value. A real falsy answer (0, false, '') is preserved as-is —
    // `response` is already `undefined` for both `null` and `undefined`
    // inputs and unchanged for everything else.
    payload: response ?? undefined,
  });
}
