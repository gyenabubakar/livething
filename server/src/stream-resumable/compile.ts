/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { Primitive } from '~/primitive.ts';
import { resumableGenerateFactory } from './stream-resumable.ts';
import type { ResumableStreamDef } from './definition.ts';

type ResumableHandlers = Map<
  string,
  (ctx: any, payload: any) => AsyncGenerator<unknown, void, unknown>
>;

export function compileResumableStreamDef(
  def: ResumableStreamDef,
  handlers: ResumableHandlers,
): Primitive {
  const generator = handlers.get(def.name);
  if (!generator) {
    throw new Error(
      `[wskit] No generator registered for resumableStream('${def.name}'). Call implement(c).resumableStream('${def.name}', ...).`,
    );
  }
  return resumableGenerateFactory({
    event: def.name,
    validator: def.payload,
    generator,
    allowConcurrent: def.allowConcurrent,
    onDisconnect: def.onDisconnect ?? 'cancel-but-buffer',
    maxAgeMs: def.maxAgeMs ?? 5 * 60_000,
    retentionAfterEndMs: def.retentionAfterEndMs ?? 30_000,
  });
}
