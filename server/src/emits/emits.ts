/* oxlint-disable @typescript-eslint/no-explicit-any */
import { capability } from '~/_define/capability.ts';
import { outgoing as outgoingFactory } from '~/outgoing/outgoing.ts';
import type { TypeMarker } from '~/_api/definitions.ts';
import type { Capability } from '~/_define/capability.ts';
import type { Validator } from '~/types.ts';

/** The payload type a single emit declaration carries. */
type EmitPayload<T> =
  T extends TypeMarker<infer U> ? U : T extends Validator<infer U> ? U : unknown;

/** The map of event name → payload type passed to `emits(...)`. */
export type EmitDefs = Record<string, TypeMarker<any> | Validator>;

/** The contract slot `emits(...)` declares — server→client events the client receives. */
type EmitSlot<TDefs extends EmitDefs> = {
  outgoing: { [K in keyof TDefs & string]: EmitPayload<TDefs[K]> };
};

/**
 * Declare the server→client, fire-and-forget events this server emits. List the
 * result in `define({ capabilities: [...] })`. Each key is an event name; each
 * value is the payload type, given as a `t<Shape>()` marker (type only) or a
 * Standard Schema. The payloads are not validated on the way out — the type just
 * flows into `ctx.send` / `ctx.broadcast` and the generated client.
 *
 * @example
 * ```ts
 * import { define, emits, t } from '@wskit/server';
 *
 * const base = define({
 *   env: t<Env>(),
 *   capabilities: [
 *     emits({
 *       message: t<{ text: string; from: string }>(),
 *       'user-joined': t<{ username: string }>(),
 *     }),
 *   ],
 * });
 * ```
 */
export function emits<const TDefs extends EmitDefs>(defs: TDefs): Capability<EmitSlot<TDefs>> {
  const primitives = Object.keys(defs).map((name) => outgoingFactory(name));
  return capability<EmitSlot<TDefs>>(primitives);
}
