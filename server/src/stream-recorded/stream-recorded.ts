/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { OnDisconnect } from '~/_engine/stream-durable/types.ts';
import type { Primitive } from '~/primitive.ts';
import type { DurableNudgeDeclaration } from '~/stream-resumable/stream-resumable.ts';
import type { Validator } from '~/types.ts';

const RECORDED_STREAM_KEY = Symbol('recorded-stream');
const RECORDED_STREAM_GENERATE_KEY = Symbol('recorded-stream-generate');

/** Compiled recorded-stream primitive — paired with the generator handler. */
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
}

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
    broadcast: input.broadcast ?? false,
    onDisconnect: input.onDisconnect ?? 'cancel-but-buffer',
    nudges: input.nudges ?? [],
    maxChunks: input.maxChunks,
    maxAgeMs: input.maxAgeMs,
    retentionAfterEndMs: input.retentionAfterEndMs,
  };
}

recordedGenerateFactory.__key = RECORDED_STREAM_GENERATE_KEY;

/** Identity-only handle for `dependencies: [recordedStreamFactory]` on modules. */
export const recordedStreamFactory = {
  __key: RECORDED_STREAM_KEY,
} as const;
