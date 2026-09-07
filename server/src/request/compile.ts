/* oxlint-disable @typescript-eslint/no-explicit-any */
import { request as requestFactory } from '~/request/request.ts';
import type { Primitive } from '~/primitive.ts';
import type { RequestDef } from '~/request/definition.ts';

export function compileRequestDef(
  def: RequestDef,
  handlers: Map<string, (ctx: any, payload: any) => any>,
): Primitive {
  const handler = handlers.get(def.name);
  if (!handler) {
    throw new Error(
      `[wskit] No handler assembled for request('${def.name}'). Include the value returned by base.request(...) in base.assemble({ handlers: [...] }).`,
    );
  }

  return requestFactory(def.name, handler as any, {
    validator: def.payload,
    responseSchema: def.response,
  });
}
