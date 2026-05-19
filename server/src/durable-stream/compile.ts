/* oxlint-disable @typescript-eslint/no-explicit-any */
/**
 * Compile durable stream definitions (`resumableStream(...)`,
 * `recordedStream(...)`) into the same `StreamPrimitive` + `GeneratePrimitive`
 * pair the plain `stream()` definition produces — with a `durable` block on
 * the `StreamPrimitive`. The engine dispatcher reads `durable` to route to
 * the durable runtime instead of the plain runtime.
 */

import { generate as generateFactory, stream as streamFactory } from '~/stream/stream.ts';
import type { Primitive } from '~/primitive.ts';
import type { RecordedStreamDef, ResumableStreamDef } from './definition.ts';

type DurableHandlers = Map<
  string,
  (ctx: any, payload: any) => AsyncGenerator<unknown, void, unknown>
>;

export function compileResumableStreamDef(
  def: ResumableStreamDef,
  handlers: DurableHandlers,
): Primitive {
  const generator = handlers.get(def.name);
  if (!generator) {
    throw new Error(
      `[wskit] No generator registered for resumableStream('${def.name}'). Call implement(c).resumableStream('${def.name}', ...).`,
    );
  }
  const streamPrim = streamFactory({
    event: def.name,
    validator: def.payload,
    broadcast: false,
    allowConcurrent: def.allowConcurrent,
    durable: {
      kind: 'resumable',
      onDisconnect: def.onDisconnect ?? 'cancel-but-buffer',
      maxAgeMs: def.maxAgeMs ?? 5 * 60_000,
      retentionAfterEndMs: def.retentionAfterEndMs ?? 30_000,
    },
  });
  return generateFactory(streamPrim, generator as any);
}

export function compileRecordedStreamDef(
  def: RecordedStreamDef,
  handlers: DurableHandlers,
): Primitive {
  const generator = handlers.get(def.name);
  if (!generator) {
    throw new Error(
      `[wskit] No generator registered for recordedStream('${def.name}'). Call implement(c).recordedStream('${def.name}', ...).`,
    );
  }
  const streamPrim = streamFactory({
    event: def.name,
    validator: def.payload,
    broadcast: false,
    allowConcurrent: def.allowConcurrent,
    durable: {
      kind: 'recorded',
      onDisconnect: def.onDisconnect ?? 'cancel-but-buffer',
      maxChunks: def.maxChunks,
      maxAgeMs: def.maxAgeMs ?? 5 * 60_000,
      retentionAfterEndMs: def.retentionAfterEndMs ?? 30_000,
    },
  });
  return generateFactory(streamPrim, generator as any);
}
