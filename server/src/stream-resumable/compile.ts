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
  // A non-broadcast resumable stream does not buffer chunks (only the cursor),
  // so chunks produced while the owning client is disconnected would silently
  // fall on the floor. Block the combination at build time and tell the dev
  // either to enable broadcast (which buffers) or use a recordedStream.
  if (def.onDisconnect === 'keep-running' && !def.broadcast) {
    throw new Error(
      `[wskit] resumableStream('${def.name}') has onDisconnect: 'keep-running' but broadcast is off. ` +
        `A non-broadcast resumable stream does not buffer chunks, so anything produced after the ` +
        `client drops would be lost. Set broadcast: true, or switch to recordedStream if you want ` +
        `a buffered keep-running stream for a single client.`,
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
    highWaterMark: def.highWaterMark,
  });
}
