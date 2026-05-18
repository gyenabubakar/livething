/* oxlint-disable @typescript-eslint/no-explicit-any */
import { scheduled as scheduledFactory } from '~/scheduled/scheduled.ts';
import type { Primitive } from '~/primitive.ts';
import type { ScheduledDef } from '~/scheduled/definition.ts';

export function compileScheduledDef(
  def: ScheduledDef,
  handlers: Map<string, (ctx: any, data: any) => void | Promise<void>>,
): Primitive {
  const handler = handlers.get(def.id);
  if (!handler) {
    throw new Error(
      `[wskit] No handler registered for scheduled('${def.id}'). Call implement(c).scheduled('${def.id}', ...).`,
    );
  }
  return scheduledFactory(def.id, (b) => {
    let bb: any = b;
    if (def.data) bb = bb.data(def.data);
    if (def.retry !== undefined) bb = bb.retry(def.retry);
    if (def.every !== undefined) bb = bb.every(def.every);
    return bb.run(handler);
  });
}
