/* oxlint-disable @typescript-eslint/no-explicit-any */
import { assertValidLiveThingIdentifier, WIRE_LIMITS } from '@livething/core';
import { CAPABILITY_KIND } from '~/_define/capability-kinds.ts';
import { capability, stampKind, withCapabilityKind } from '~/_define/capability.ts';
import { makeServerRequestsPrimitive, serverRequestKey } from '~/request/outgoing-runtime.ts';
import type { TypeMarker } from '~/_api/definitions.ts';
import type { Capability } from '~/_define/capability.ts';
import type { Validator } from '~/types.ts';

export type ServerRequestDeclaration = {
  readonly out: TypeMarker<any>;
  readonly in?: Validator;
};

type PayloadOf<TDeclaration> = TDeclaration extends { out: TypeMarker<infer U> } ? U : unknown;
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
  readonly __registerServerRequests: (
    channelKey: string,
    declarations: Record<string, ServerRequestDeclaration>,
  ) => void;
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
    __registerServerRequests: ServerRequestsCapability['__registerServerRequests'];
  };
  writable.__channelServerRequests = declarations;
  writable.__serverRequests = resolved;
  writable.__registerServerRequests = (channelKey, channelDeclarations) => {
    for (const [event, declaration] of Object.entries(channelDeclarations)) {
      assertValidLiveThingIdentifier(event, 'serverRequests() event name', WIRE_LIMITS.event);
      resolved.set(serverRequestKey(channelKey, event), resolveServerRequest(declaration));
    }
  };

  return stampKind(cap, CAPABILITY_KIND.serverRequests);
}, CAPABILITY_KIND.serverRequests);
