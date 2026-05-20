/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { Primitive } from '~/primitive.ts';
import { resumableGenerateFactory } from './stream-resumable.ts';
import type { ResumableStreamDef } from './definition.ts';

type ResumableHandlers = Map<
  string,
  (ctx: any, payload: any) => AsyncGenerator<unknown, void, unknown>
>;

/**
 * Pair a `ResumableStreamDef` with the generator registered on the
 * implementer and produce the runtime primitive the engine mounts. Throws
 * when no generator was registered for the stream's name.
 */
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
    cursor: def.cursor,
    generator,
    allowConcurrent: def.allowConcurrent,
    broadcast: def.broadcast,
    onDisconnect: def.onDisconnect ?? 'cancel-but-buffer',
    nudges: def.nudges.map((n) => ({ event: n.name, validator: n.schema })),
    maxChunks: def.maxChunks,
    maxAgeMs: def.maxAgeMs ?? 5 * 60_000,
    retentionAfterEndMs: def.retentionAfterEndMs ?? 30_000,
  });
}
