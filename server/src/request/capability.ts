/* oxlint-disable @typescript-eslint/no-explicit-any */
import { CAPABILITY_KIND } from '~/_define/capability-kinds.ts';
import { capability, stampKind, withCapabilityKind } from '~/_define/capability.ts';
import { makeServerRequestsPrimitive, serverRequestKey } from '~/request/outgoing-runtime.ts';
import { request as requestFactory } from '~/request/request.ts';
import type { TypeMarker } from '~/_api/definitions.ts';
import type { Capability } from '~/_define/capability.ts';
import type { Primitive } from '~/primitive.ts';
import type { Validator } from '~/types.ts';

/** The config a request builder accepts — an optional input schema and the run that returns the reply. */
export interface RequestBuildConfig {
  readonly input?: Validator;
  run(ctx: any, input: any): unknown;
}

/**
 * One server→client request declaration. Either a bare `t<…>()` marker — an
 * acknowledgement request, where the client just confirms receipt and the caller
 * resolves with no value — or `{ out, in }`, where `out` is the type the server
 * sends (a marker, trusted, not validated outbound) and `in` is the schema the
 * client's answer is validated against. Targeted vs fan-out is decided by the
 * verb (`request` vs `broadcastRequest`), not the declaration.
 */
export type ServerRequestDeclaration =
  | TypeMarker<any>
  | { readonly out: TypeMarker<any>; readonly in: Validator };

/** The `out` (server→client payload) type a request declaration carries. */
type PayloadOf<TDeclaration> =
  TDeclaration extends TypeMarker<infer U>
    ? U
    : TDeclaration extends { out: TypeMarker<infer U> }
      ? U
      : unknown;

/** The `in` (client→server answer) type a declaration carries; `void` for an acknowledgement. */
type ResponseOf<TDeclaration> = TDeclaration extends { in: Validator<infer U> } ? U : void;

/** The contract slot `requests({...})` declares — event → { payload, response }. */
type ServerRequestsSlot<TDeclarations extends Record<string, ServerRequestDeclaration>> = {
  serverRequests: {
    [K in keyof TDeclarations & string]: {
      payload: PayloadOf<TDeclarations[K]>;
      response: ResponseOf<TDeclarations[K]>;
    };
  };
};

/** The resolved, runtime form of one server→client request declaration. */
export interface ResolvedServerRequest {
  /** The schema the client's answer is validated against; absent for an acknowledgement request. */
  readonly responseValidator?: Validator;
}

/** A `requests()` capability, carrying the builder so the core never imports the request factory. */
export interface RequestsCapability<
  TDeclarations extends Record<string, ServerRequestDeclaration> = Record<
    string,
    ServerRequestDeclaration
  >,
> extends Capability<ServerRequestsSlot<TDeclarations>, never, 'requests'> {
  /** Build a request primitive from a `base.request(...)` / channel `request(...)` config. @internal */
  readonly __buildRequest: (event: string, config: RequestBuildConfig) => Primitive;
  /**
   * Resolved server→client request declarations, keyed by
   * `serverRequestKey(channelKey, event)` so a channel's declarations never collide
   * with another channel's or with a top-level declaration of the same event name.
   * @internal
   */
  readonly __serverRequests: ReadonlyMap<string, ResolvedServerRequest>;
  /**
   * Merge a channel's own `outgoing.requests` declarations into the engine's
   * server→client request table, keyed by the channel's definition key, so
   * `ctx.channel.request` / `ctx.channel.broadcastRequest` validate responses
   * and gate the broadcast flag the same way top-level declarations do without
   * clobbering same-named declarations on other channels. The channels capability
   * borrows this seam so it never imports the request engine. @internal
   */
  readonly __registerServerRequests: (
    channelKey: string,
    declarations: Record<string, ServerRequestDeclaration>,
  ) => void;
}

function resolveServerRequest(declaration: ServerRequestDeclaration): ResolvedServerRequest {
  return {
    responseValidator: 'in' in declaration ? declaration.in : undefined,
  };
}

/**
 * Enable two-way requests. Listing this lets you register `base.request`
 * (and channel `request`) handlers for client→server requests — a request is
 * like `base.on`, but the client awaits a reply and the reply type is inferred
 * from what the handler returns. Returning nothing rejects the client's pending
 * request.
 *
 * Passing a declaration map also enables **server→client** requests: the server
 * asks one connection a question with `ctx.request(event, payload)` (or
 * `ctx.connection(ref).request(...)` / `ctx.channel.request(...)`) and awaits
 * the client's typed answer. Each `response` schema validates the client's
 * reply; an answer that fails it rejects the server promise with
 * `request-invalid-response`.
 *
 * @example
 * ```ts
 * import { define, t } from '@wskit/server';
 * import { requests } from '@wskit/server/requests';
 * import * as v from 'valibot';
 *
 * const base = define({
 *   env: t<Env>(),
 *   capabilities: [
 *     requests({
 *       'ask-permission': { out: t<{ action: string }>(), in: v.object({ allowed: v.boolean() }) },
 *     }),
 *   ],
 * });
 *
 * export const handleGetTime = base.request('get-time', {
 *   input: v.object({}),
 *   run() {
 *     return { now: new Date().toISOString() };
 *   },
 * });
 * ```
 */
export const requests = withCapabilityKind(function requests<
  const TDeclarations extends Record<string, ServerRequestDeclaration> = {},
>(declarations: TDeclarations = {} as TDeclarations): RequestsCapability<TDeclarations> {
  const serverRequests = new Map<string, ResolvedServerRequest>();
  for (const [event, declaration] of Object.entries(declarations)) {
    serverRequests.set(serverRequestKey(null, event), resolveServerRequest(declaration));
  }

  const cap = capability<ServerRequestsSlot<TDeclarations>, never, 'requests'>([
    makeServerRequestsPrimitive(serverRequests),
  ]) as RequestsCapability<TDeclarations>;

  const writable = cap as {
    __buildRequest: RequestsCapability['__buildRequest'];
    __serverRequests: RequestsCapability['__serverRequests'];
    __registerServerRequests: RequestsCapability['__registerServerRequests'];
  };
  writable.__serverRequests = serverRequests;
  writable.__registerServerRequests = (channelKey, channelDeclarations) => {
    for (const [event, declaration] of Object.entries(channelDeclarations)) {
      serverRequests.set(serverRequestKey(channelKey, event), resolveServerRequest(declaration));
    }
  };
  writable.__buildRequest = (event, config) => {
    const run = config.run;
    return requestFactory(
      event,
      async (ctx: { respond(value: unknown): void }, payload: unknown) => {
        const result = await run(ctx, payload);
        // `undefined` is the only "no answer" signal (rejects the client with
        // request-no-response); a returned `null` is a real, nullable response.
        if (result !== undefined) ctx.respond(result);
      },
      config.input ? { validator: config.input } : undefined,
    );
  };
  return stampKind(cap, CAPABILITY_KIND.requests);
}, CAPABILITY_KIND.requests);
