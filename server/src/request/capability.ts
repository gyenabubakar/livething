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

/** Per-declaration options carried in the optional third tuple slot. */
export interface ServerRequestOptions {
  readonly broadcast?: boolean;
}

/**
 * One server→client request declaration, a tuple `[payload, response, options?]`.
 * `[0]` is the type the server sends (a `t<…>()` marker or a validator —
 * trusted, not validated outbound), `[1]` is the schema the client's answer is
 * validated against, and the optional `[2]` carries `{ broadcast?: boolean }`. A
 * `broadcast: true` declaration is answerable only via `broadcastRequest` (Phase 3);
 * the default targeted declaration is answerable only via `request`.
 */
export type ServerRequestDeclaration =
  | readonly [payload: TypeMarker<any> | Validator, response: Validator]
  | readonly [
      payload: TypeMarker<any> | Validator,
      response: Validator,
      options: ServerRequestOptions,
    ];

/** The payload type one server→client request declaration carries. */
type PayloadOf<TDeclaration> = TDeclaration extends readonly [infer P, ...unknown[]]
  ? P extends TypeMarker<infer U>
    ? U
    : P extends Validator<infer U>
      ? U
      : unknown
  : unknown;

/** The response type one server→client request declaration carries. */
type ResponseOf<TDeclaration> = TDeclaration extends readonly [
  unknown,
  Validator<infer U>,
  ...unknown[],
]
  ? U
  : unknown;

/** Whether one declaration is a broadcast request. */
type BroadcastOf<TDeclaration> = TDeclaration extends readonly [
  unknown,
  unknown,
  { broadcast: true },
]
  ? true
  : false;

/** The contract slot `requests({...})` declares — event → { payload, response, broadcast }. */
type ServerRequestsSlot<TDeclarations extends Record<string, ServerRequestDeclaration>> = {
  serverRequests: {
    [K in keyof TDeclarations & string]: {
      payload: PayloadOf<TDeclarations[K]>;
      response: ResponseOf<TDeclarations[K]>;
      broadcast: BroadcastOf<TDeclarations[K]>;
    };
  };
};

/** The resolved, runtime form of one server→client request declaration. */
export interface ResolvedServerRequest {
  /** The schema the client's answer is validated against. */
  readonly responseValidator?: Validator;
  /** Whether this declaration is broadcast-only (Phase 3). */
  readonly broadcast: boolean;
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

/** A `t<T>()` marker carries a type only — there is no runtime validator on it. */
function isTypeMarker(value: unknown): value is TypeMarker<unknown> {
  return (
    !!value && typeof value === 'object' && (value as { __wskit_t?: unknown }).__wskit_t === 't'
  );
}

function resolveServerRequest(declaration: ServerRequestDeclaration): ResolvedServerRequest {
  const response = declaration[1];
  return {
    responseValidator: isTypeMarker(response) ? undefined : (response as Validator),
    broadcast: declaration[2]?.broadcast === true,
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
 *       'ask-permission': [t<{ action: string }>(), v.object({ allowed: v.boolean() })],
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
        if (result !== undefined && result !== null) ctx.respond(result);
      },
      config.input ? { validator: config.input } : undefined,
    );
  };
  return stampKind(cap, CAPABILITY_KIND.requests);
}, CAPABILITY_KIND.requests);
