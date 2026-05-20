/* oxlint-disable @typescript-eslint/no-explicit-any */
/**
 * Primitive factory for `recordedStream(...)`. Mirrors `~/stream-resumable/`
 * — the compile path produces one primitive (`'recorded-stream-generate'`)
 * which lands in `compiled.recordedStreams`. The dispatcher routes by map
 * presence; there is no shared declaration primitive emitted at runtime.
 */

import type { OnDisconnect } from '~/_engine/stream-durable/types.ts';
import type { Primitive } from '~/primitive.ts';
import type { Validator } from '~/types.ts';

const RECORDED_STREAM_KEY = Symbol('recorded-stream');
const RECORDED_STREAM_GENERATE_KEY = Symbol('recorded-stream-generate');

/**
 * Compiled recorded-stream primitive. Carries the trigger event, the
 * generator, and the durable-stream config (chunk-buffer mode, retention,
 * `maxChunks` cap, on-disconnect policy).
 */
export interface RecordedStreamGeneratePrimitive extends Primitive<'recorded-stream-generate'> {
  readonly event: string;
  readonly validator?: Validator<unknown>;
  readonly generator: (ctx: any, payload: any) => AsyncGenerator<unknown, void, unknown>;
  readonly allowConcurrent: boolean;
  readonly onDisconnect: OnDisconnect;
  readonly maxChunks: number;
  readonly maxAgeMs: number;
  readonly retentionAfterEndMs: number;
}

export interface BuildRecordedStreamGenerateInput {
  event: string;
  validator?: Validator<unknown>;
  generator: (ctx: any, payload: any) => AsyncGenerator<unknown, void, unknown>;
  allowConcurrent?: boolean;
  onDisconnect?: OnDisconnect;
  maxChunks: number;
  maxAgeMs: number;
  retentionAfterEndMs: number;
}

export function recordedGenerateFactory(
  input: BuildRecordedStreamGenerateInput,
): RecordedStreamGeneratePrimitive {
  return {
    __wskit: 'recorded-stream-generate',
    __kind: 'handler',
    __identity: [RECORDED_STREAM_GENERATE_KEY, input.event],
    __requires: { storage: true, timers: true },
    event: input.event,
    validator: input.validator,
    generator: input.generator,
    allowConcurrent: input.allowConcurrent ?? false,
    onDisconnect: input.onDisconnect ?? 'cancel-but-buffer',
    maxChunks: input.maxChunks,
    maxAgeMs: input.maxAgeMs,
    retentionAfterEndMs: input.retentionAfterEndMs,
  };
}

recordedGenerateFactory.__key = RECORDED_STREAM_GENERATE_KEY;

/**
 * Identity-only declaration factory. Used by modules to declare a
 * dependency on the recorded-stream feature via `factory.__key`.
 */
export const recordedStreamFactory = {
  __key: RECORDED_STREAM_KEY,
} as const;
