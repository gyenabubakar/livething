import type { Primitive } from '~/primitive.ts';
import type { StreamGenerator } from '~/stream/shared.ts';
import { recordedGenerateFactory } from './stream-recorded.ts';
import type { RecordedStreamDef } from './definition.ts';

type RecordedHandlers = Map<string, StreamGenerator>;

/**
 * Pair a `RecordedStreamDef` with a generator selected during assembly and
 * produce the runtime primitive the engine mounts. Throws when the stream's
 * handler value was not assembled.
 */
export function compileRecordedStreamDef(
  def: RecordedStreamDef,
  handlers: RecordedHandlers,
): Primitive {
  const generator = handlers.get(def.name);
  if (!generator) {
    throw new Error(
      `[livething] No handler assembled for recordedStream('${def.name}'). Include the value returned by base.recordedStream(...) in base.assemble({ handlers: [...] }).`,
    );
  }

  return recordedGenerateFactory({
    event: def.name,
    validator: def.payload,
    generator,
    allowConcurrent: def.allowConcurrent,
    broadcast: def.broadcast,
    nudges: def.nudges.map((n) => ({ event: n.name, validator: n.schema })),
    maxChunks: def.maxChunks,
    maxBufferBytes: def.maxBufferBytes,
    maxAgeMs: def.maxAgeMs ?? 5 * 60_000,
    retentionAfterEndMs: def.retentionAfterEndMs ?? 30_000,
  });
}
