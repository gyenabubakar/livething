/* oxlint-disable @typescript-eslint/no-explicit-any */
import { CAPABILITY_KIND } from '~/_define/capability-kinds.ts';
import { capability, stampKind, withCapabilityKind } from '~/_define/capability.ts';
import { requestRuntimePrimitive } from '~/request/registrar.ts';
import { request as requestFactory } from '~/request/request.ts';
import type { Capability } from '~/_define/capability.ts';
import type { Primitive } from '~/primitive.ts';
import type { Validator } from '~/types.ts';

type CtxParameter = { respond(value: unknown): void };

export interface RequestBuildConfig {
  readonly input?: Validator;
  readonly allowInterleaving?: boolean;
  run(ctx: any, input: any): unknown;
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
      return requestFactory(
        event,
        async (ctx: CtxParameter, payload: unknown) => {
          const result = await run(ctx, payload);
          if (result != null) ctx.respond(result);
        },
        {
          validator: config.input,
          allowInterleaving: config.allowInterleaving,
        },
      );
    };
    return stampKind(cap, CAPABILITY_KIND.clientRequests);
  },
  CAPABILITY_KIND.clientRequests,
);
