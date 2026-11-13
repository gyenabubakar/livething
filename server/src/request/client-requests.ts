/* oxlint-disable @typescript-eslint/no-explicit-any */
import { CAPABILITY_KIND } from '~/_define/capability-kinds.ts';
import { capability, stampKind, withCapabilityKind } from '~/_define/capability.ts';
import { binaryHandlerFields } from '~/incoming/incoming.ts';
import { binaryPayloadOf } from '~/outgoing/binary-payload.ts';
import { requestRuntimePrimitive } from '~/request/registrar.ts';
import { request as requestFactory } from '~/request/request.ts';
import type { Capability } from '~/_define/capability.ts';
import type { Primitive } from '~/primitive.ts';
import type { Validator } from '~/types.ts';

type CtxParameter = { respond(value: unknown): void };

export interface RequestBuildConfig {
  readonly input?: Validator;
  readonly allowInterleaving?: boolean;
  /** Set by `base.binary.request(...)`: the request and its reply are binary frames. */
  readonly binary?: boolean;
  /** The most bytes a binary request frame may carry. */
  readonly maxBytes?: number;
  run(ctx: any, input: any, bytes?: Uint8Array): unknown;
}

export interface ClientRequestsCapability extends Capability<
  {},
  never,
  'clientRequests',
  typeof CAPABILITY_KIND.clientRequests
> {
  readonly __buildClientRequest: (event: string, config: RequestBuildConfig) => Primitive;
}

export const clientRequests = withCapabilityKind(
  function clientRequests(): ClientRequestsCapability {
    const cap = capability<{}, never, 'clientRequests', typeof CAPABILITY_KIND.clientRequests>([
      requestRuntimePrimitive(),
    ]) as ClientRequestsCapability;
    (
      cap as { __buildClientRequest: ClientRequestsCapability['__buildClientRequest'] }
    ).__buildClientRequest = (event, config) => {
      const run = config.run;
      const method = `binary.request('${event}')`;
      const primitive = requestFactory(
        event,
        async (ctx: CtxParameter, payload: unknown, bytes?: Uint8Array) => {
          const result = await run(ctx, payload, bytes);
          // A binary request always replies with one binary frame, so its `run` must return one.
          if (config.binary) ctx.respond(binaryPayloadOf(method, result, false));
          else if (result != null) ctx.respond(result);
        },
        {
          validator: config.input,
          allowInterleaving: config.allowInterleaving,
        },
      );

      return config.binary
        ? { ...primitive, ...binaryHandlerFields(method, config.maxBytes) }
        : primitive;
    };
    return stampKind(cap, CAPABILITY_KIND.clientRequests);
  },
  CAPABILITY_KIND.clientRequests,
);
