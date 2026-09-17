/* oxlint-disable @typescript-eslint/no-explicit-any */
import { CAPABILITY_KIND } from '~/_define/capability-kinds.ts';
import { capability, stampKind, withCapabilityKind } from '~/_define/capability.ts';
import { outgoing as outgoingFactory } from '~/outgoing/outgoing.ts';
import type { TypeMarker } from '~/_api/definitions.ts';
import type { Capability } from '~/_define/capability.ts';

/** The payload type a single emit declaration carries. */
type EmitPayload<T> = T extends TypeMarker<infer U> ? U : unknown;

/** The map of event name → payload type passed to `emits(...)`. Outgoing events
 * are server-produced and never validated, so the value is a `t<…>()` marker
 * (type only), not a schema. */
export type EmitDefs = Record<string, TypeMarker<any>>;

/** The contract slot `emits(...)` declares — server→client events the client receives. */
export type EmitSlot<TDefs extends EmitDefs> = {
  outgoing: { [K in keyof TDefs & string]: EmitPayload<TDefs[K]> };
};

/**
 * Declare the server→client, fire-and-forget events this server emits. List the
 * result in `server({ capabilities: [...] })`. Each key is an event name; each
 * value is the payload type, given as a `t<Shape>()` marker. Outgoing payloads
 * are server-produced and not validated on the way out — the type just flows
 * into `ctx.send` / `ctx.broadcast` and the generated client.
 *
 * @example
 * ```ts
 * import { server, emits, t } from '@wskit/server';
 *
 * const base = server({
 *   capabilities: [
 *     emits({
 *       message: t<{ text: string; from: string }>(),
 *       'user-joined': t<{ username: string }>(),
 *     }),
 *   ],
 * });
 * ```
 */
export type EmitsCapability<TDefs extends EmitDefs> = Capability<
  EmitSlot<TDefs>,
  never,
  'emits'
> & {
  readonly __channelEmits: TDefs;
};

export const emits = withCapabilityKind(function emits<const TDefs extends EmitDefs>(
  defs: TDefs,
): EmitsCapability<TDefs> {
  const primitives = Object.keys(defs).map((name) => outgoingFactory(name));
  return stampKind(
    capability<EmitSlot<TDefs>>(primitives, [], { __channelEmits: defs }),
    CAPABILITY_KIND.emits,
  ) as EmitsCapability<TDefs>;
}, CAPABILITY_KIND.emits);
