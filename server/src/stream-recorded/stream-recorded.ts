/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { OnDisconnect } from '~/_engine/stream-durable/types.ts';
import type { Primitive } from '~/primitive.ts';
import type { DurableNudgeDeclaration } from '~/stream-resumable/stream-resumable.ts';
import type { Validator } from '~/types.ts';

const RECORDED_STREAM_KEY = Symbol('recorded-stream');
const RECORDED_STREAM_GENERATE_KEY = Symbol('recorded-stream-generate');

/**
 * Compiled recorded-stream primitive — the contract declaration plus the
 * generator function, ready for the engine to mount. Produced by
 * `compileRecordedStreamDef`. Library users do not touch this directly.
 */
export interface RecordedStreamGeneratePrimitive extends Primitive<'recorded-stream-generate'> {
  readonly event: string;
  readonly validator?: Validator<unknown>;
  readonly generator: (ctx: any, payload: any) => AsyncGenerator<unknown, void, unknown>;
  readonly allowConcurrent: boolean;
  readonly broadcast: boolean;
  readonly onDisconnect: OnDisconnect;
  readonly nudges: readonly DurableNudgeDeclaration[];
  readonly maxChunks: number;
  readonly maxAgeMs: number;
  readonly retentionAfterEndMs: number;
  /** Outbound backpressure limit in bytes used by `ctx.stream.drain()`. Undefined = default 256 KB. */
  readonly highWaterMark?: number;
}

/** Inputs accepted by `recordedGenerateFactory`. */
export interface BuildRecordedStreamGenerateInput {
  event: string;
  validator?: Validator<unknown>;
  generator: (ctx: any, payload: any) => AsyncGenerator<unknown, void, unknown>;
  allowConcurrent?: boolean;
  broadcast?: boolean;
  onDisconnect?: OnDisconnect;
  nudges?: readonly DurableNudgeDeclaration[];
  maxChunks: number;
  maxAgeMs: number;
  retentionAfterEndMs: number;
  highWaterMark?: number;
}

/** Build the runtime primitive used by the engine to mount one recorded stream. */
export function recordedGenerateFactory(
  input: BuildRecordedStreamGenerateInput,
): RecordedStreamGeneratePrimitive {
  return {
    __wskit: 'recorded-stream-generate',
    __kind: 'handler',
    __identity: [RECORDED_STREAM_GENERATE_KEY, input.event],
    __requires: { storage: true },
    event: input.event,
    validator: input.validator,
    generator: input.generator,
    allowConcurrent: input.allowConcurrent ?? false,
    broadcast: input.broadcast ?? false,
    onDisconnect: input.onDisconnect ?? 'cancel-but-buffer',
    nudges: input.nudges ?? [],
    maxChunks: input.maxChunks,
    maxAgeMs: input.maxAgeMs,
    retentionAfterEndMs: input.retentionAfterEndMs,
    highWaterMark: input.highWaterMark,
  };
}

recordedGenerateFactory.__key = RECORDED_STREAM_GENERATE_KEY;

/** Identity-only handle for `dependencies: [recordedStreamFactory]` on plugins. */
export const recordedStreamFactory = {
  __key: RECORDED_STREAM_KEY,
} as const;
