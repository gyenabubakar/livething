/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { Primitive } from '~/primitive.ts';
import { recordedGenerateFactory } from './stream-recorded.ts';
import type { RecordedStreamDef } from './definition.ts';

type RecordedHandlers = Map<
  string,
  (ctx: any, payload: any) => AsyncGenerator<unknown, void, unknown>
>;

/**
 * Pair a `RecordedStreamDef` with the generator registered on the
 * implementer and produce the runtime primitive the engine mounts. Throws
 * when no generator was registered for the stream's name.
 */
export function compileRecordedStreamDef(
  def: RecordedStreamDef,
  handlers: RecordedHandlers,
): Primitive {
  const generator = handlers.get(def.name);
  if (!generator) {
    throw new Error(
      `[wskit] No generator registered for recordedStream('${def.name}'). Call implement(c).recordedStream('${def.name}', ...).`,
    );
  }
  return recordedGenerateFactory({
    event: def.name,
    validator: def.payload,
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
