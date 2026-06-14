/* oxlint-disable @typescript-eslint/no-explicit-any */
import { capability } from '~/_define/capability.ts';
import { request as requestFactory } from '~/request/request.ts';
import type { Capability } from '~/_define/capability.ts';
import type { Primitive } from '~/primitive.ts';
import type { Validator } from '~/types.ts';

/** The config a request builder accepts — an optional input schema and the run that returns the reply. */
export interface RequestBuildConfig {
  readonly input?: Validator;
  run(ctx: any, input: any): unknown;
}

/** A `requests()` capability, carrying the builder so the core never imports the request factory. */
export interface RequestsCapability extends Capability<{}, never, 'requests'> {
  /** Build a request primitive from a `base.request(...)` / channel `request(...)` config. @internal */
  readonly __buildRequest: (event: string, config: RequestBuildConfig) => Primitive;
}

/**
 * Enable client→server requests. Listing this lets you register `base.request`
 * (and channel `request`) handlers — a request is like `base.on`, but the client
 * awaits a reply and the reply type is inferred from what the handler returns.
 * Returning nothing rejects the client's pending request.
 *
 * @example
 * ```ts
 * import { define, t } from '@wskit/server';
 * import { requests } from '@wskit/server/requests';
 * import * as v from 'valibot';
 *
 * const base = define({ env: t<Env>(), capabilities: [requests()] });
 *
 * export const handleGetTime = base.request('get-time', {
 *   input: v.object({}),
 *   run() {
 *     return { now: new Date().toISOString() };
 *   },
 * });
 * ```
 */
export function requests(): RequestsCapability {
  const cap = capability<{}, never, 'requests'>([]) as RequestsCapability;
  (cap as { __buildRequest: RequestsCapability['__buildRequest'] }).__buildRequest = (
    event,
    config,
  ) => {
    const run = config.run;
    return requestFactory(
      event,
      async (ctx: { respond(value: unknown): void }, payload: unknown) => {
        const result = await run(ctx, payload);
        if (result !== undefined && result !== null) ctx.respond(result);
      },
      config.input ? { validator: config.input } : undefined,
    );
  };
  return cap;
}
