/* oxlint-disable @typescript-eslint/no-explicit-any */
import { incoming as incomingFactory } from '~/incoming/incoming.ts';
import type { IncomingDef } from '~/incoming/definition.ts';
import type { Primitive } from '~/primitive.ts';

export function compileIncomingDef(
  def: IncomingDef,
  handlers: Map<string, (ctx: any, payload: any) => void | Promise<void>>,
): Primitive {
  const handler = handlers.get(def.name);
  if (!handler) {
    throw new Error(
      `[livething] No handler assembled for incoming('${def.name}'). Include the value returned by base.on(...) in base.assemble({ handlers: [...] }).`,
    );
  }

  return incomingFactory(
    def.name,
    handler as any,
    def.schema ? { validator: def.schema } : undefined,
  );
}
