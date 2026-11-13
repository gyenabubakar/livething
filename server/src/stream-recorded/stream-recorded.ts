import type { Primitive } from '~/primitive.ts';
import type { StreamGenerator } from '~/stream/shared.ts';
import type { Validator } from '~/types.ts';

const RECORDED_STREAM_GENERATE_KEY = Symbol('recorded-stream-generate');

/** One declared nudge on a recorded stream — wire event name + payload validator. */
interface DurableNudgeDeclaration {
  readonly event: string;
  readonly validator?: Validator<unknown>;
}

/**
 * Compiled recorded-stream primitive — the contract declaration plus the
 * generator function, ready for the engine to mount. Produced by
 * `compileRecordedStreamDef`. Library users do not touch this directly.
 */
export interface RecordedStreamGeneratePrimitive extends Primitive<'recorded-stream-generate'> {
  readonly event: string;
  readonly validator?: Validator<unknown>;
  readonly generator: StreamGenerator;
  readonly allowConcurrent: boolean;
  readonly broadcast: boolean;
  readonly nudges: readonly DurableNudgeDeclaration[];
  readonly maxChunks: number;
  readonly maxBufferBytes: number;
  readonly maxAgeMs: number;
  readonly retentionAfterEndMs: number;
}

/** Inputs accepted by `recordedGenerateFactory`. */
export interface BuildRecordedStreamGenerateInput {
  event: string;
  validator?: Validator<unknown>;
  generator: StreamGenerator;
  allowConcurrent?: boolean;
  broadcast?: boolean;
  nudges?: readonly DurableNudgeDeclaration[];
  maxChunks: number;
  maxBufferBytes: number;
  maxAgeMs: number;
  retentionAfterEndMs: number;
}

/** Build the runtime primitive used by the engine to mount one recorded stream. */
export function recordedGenerateFactory(
  input: BuildRecordedStreamGenerateInput,
): RecordedStreamGeneratePrimitive {
  return {
    __livething: 'recorded-stream-generate',
    __identity: [RECORDED_STREAM_GENERATE_KEY, input.event],
    __requires: {},
    event: input.event,
    validator: input.validator,
    generator: input.generator,
    allowConcurrent: input.allowConcurrent ?? false,
    broadcast: input.broadcast ?? false,
    nudges: input.nudges ?? [],
    maxChunks: input.maxChunks,
    maxBufferBytes: input.maxBufferBytes,
    maxAgeMs: input.maxAgeMs,
    retentionAfterEndMs: input.retentionAfterEndMs,
  };
}
