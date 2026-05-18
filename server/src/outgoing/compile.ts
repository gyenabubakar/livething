/* oxlint-disable @typescript-eslint/no-explicit-any */
import { outgoing as outgoingFactory } from '~/outgoing/outgoing.ts';
import type { OutgoingDef } from '~/outgoing/definition.ts';
import type { Primitive } from '~/primitive.ts';

// Outgoing has no handler — it only exists so the client gets the right types.
export function compileOutgoingDef(def: OutgoingDef): Primitive {
  return outgoingFactory(def.name);
}
