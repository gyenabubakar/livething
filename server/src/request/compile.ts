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
      `[wskit] No handler registered for request('${def.name}'). Call implement(c).request('${def.name}', ...).`,
    );
  }
  // The runtime expects the handler to send the reply via ctx.respond().
  // Users can also just return the value, so we forward it for them here.
  async function adapted(ctx: any, payload: any): Promise<void> {
    const result = await (handler as any)(ctx, payload);
    if (result !== undefined) ctx.respond(result);
  }
  return requestFactory(def.name, adapted, {
    validator: def.payload,
    responseSchema: def.response,
  });
}
