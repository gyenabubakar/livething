/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { Primitive } from '~/primitive.ts';
import { resumableGenerateFactory } from './stream-resumable.ts';
import type { ResumableStreamDef } from './definition.ts';

type ResumableHandlers = Map<
  string,
  (ctx: any, payload: any) => AsyncGenerator<unknown, void, unknown>
>;

/**
 * Pair a `ResumableStreamDef` with a generator selected during assembly and
 * produce the runtime primitive the engine mounts. Throws when the stream's
 * handler value was not assembled.
 */
export function compileResumableStreamDef(
  def: ResumableStreamDef,
  handlers: ResumableHandlers,
): Primitive {
  const generator = handlers.get(def.name);
  if (!generator) {
    throw new Error(
      `[wskit] No handler assembled for resumableStream('${def.name}'). Include the value returned by base.resumableStream(...) in base.assemble({ handlers: [...] }).`,
    );
  }
  if (def.onDisconnect === 'keep-running' && !def.broadcast) {
    throw new Error(
      `[wskit] resumableStream('${def.name}') has onDisconnect: 'keep-running' but broadcast is off. ` +
        `A resumable stream never buffers chunks (only its cursor), so with no broadcast peer every ` +
        `chunk produced while the client is gone reaches nobody and is lost. Set broadcast: true so ` +
        `live peers keep receiving, or switch to recordedStream if a reconnecting client must replay ` +
        `the chunks it missed.`,
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
    maxAgeMs: def.maxAgeMs ?? 5 * 60_000,
    retentionAfterEndMs: def.retentionAfterEndMs ?? 30_000,
    highWaterMark: def.highWaterMark,
  });
}
