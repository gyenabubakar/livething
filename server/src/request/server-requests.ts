/* oxlint-disable @typescript-eslint/no-explicit-any */
import { assertValidLiveThingIdentifier, WIRE_LIMITS } from '@livething/core';
import { CAPABILITY_KIND } from '~/_define/capability-kinds.ts';
import { capability, stampKind, withCapabilityKind } from '~/_define/capability.ts';
import { makeServerRequestsPrimitive, serverRequestKey } from '~/request/outgoing-runtime.ts';
import type { TypeMarker } from '~/_api/definitions.ts';
import type { Capability } from '~/_define/capability.ts';
import type { ContractPayload, Payload, Validator } from '~/types.ts';

export type ServerRequestDeclaration = {
  /** The payload sent to the client, which must be a plain object or `null`. */
  readonly out: TypeMarker<Payload>;
  readonly in?: Validator;
};

type PayloadOf<TDeclaration> = TDeclaration extends { out: TypeMarker<infer U> }
  ? ContractPayload<U>
  : unknown;
type ResponseOf<TDeclaration> = TDeclaration extends { in: Validator<infer U> } ? U : void;

export type ServerRequestsSlot<TDeclarations extends Record<string, ServerRequestDeclaration>> = {
  serverRequests: {
    [K in keyof TDeclarations & string]: {
      payload: PayloadOf<TDeclarations[K]>;
      response: ResponseOf<TDeclarations[K]>;
    };
  };
};

export interface ResolvedServerRequest {
  readonly responseValidator?: Validator;
}

export interface ServerRequestsCapability<
  TDeclarations extends Record<string, ServerRequestDeclaration> = Record<
    string,
    ServerRequestDeclaration
  >,
> extends Capability<
  ServerRequestsSlot<TDeclarations>,
  never,
  'serverRequests',
  typeof CAPABILITY_KIND.serverRequests
> {
  readonly __channelServerRequests: TDeclarations;
  readonly __serverRequests: ReadonlyMap<string, ResolvedServerRequest>;
  readonly __resolveChannelServerRequests: (
    channelKey: string,
    declarations: Record<string, ServerRequestDeclaration>,
  ) => ReadonlyMap<string, ResolvedServerRequest>;
}

function resolveServerRequest(declaration: ServerRequestDeclaration): ResolvedServerRequest {
  return { responseValidator: declaration.in };
}

export const serverRequests = withCapabilityKind(function serverRequests<
  const TDeclarations extends Record<string, ServerRequestDeclaration> = {},
>(declarations: TDeclarations = {} as TDeclarations): ServerRequestsCapability<TDeclarations> {
  const resolved = new Map<string, ResolvedServerRequest>();
  for (const [event, declaration] of Object.entries(declarations)) {
    assertValidLiveThingIdentifier(event, 'serverRequests() event name', WIRE_LIMITS.event);
    resolved.set(serverRequestKey(null, event), resolveServerRequest(declaration));
  }

  const cap = capability<
    ServerRequestsSlot<TDeclarations>,
    never,
    'serverRequests',
    typeof CAPABILITY_KIND.serverRequests
  >([makeServerRequestsPrimitive(resolved)]) as ServerRequestsCapability<TDeclarations>;

  const writable = cap as {
    __channelServerRequests: TDeclarations;
    __serverRequests: ServerRequestsCapability['__serverRequests'];
    __resolveChannelServerRequests: ServerRequestsCapability['__resolveChannelServerRequests'];
  };
  writable.__channelServerRequests = declarations;
  writable.__serverRequests = resolved;
  writable.__resolveChannelServerRequests = (channelKey, channelDeclarations) => {
    const channelRequests = new Map<string, ResolvedServerRequest>();
    for (const [event, declaration] of Object.entries(channelDeclarations)) {
      assertValidLiveThingIdentifier(event, 'serverRequests() event name', WIRE_LIMITS.event);
      channelRequests.set(serverRequestKey(channelKey, event), resolveServerRequest(declaration));
    }

    return channelRequests;
  };

  return stampKind(cap, CAPABILITY_KIND.serverRequests);
}, CAPABILITY_KIND.serverRequests);
