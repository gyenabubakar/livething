/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { OnDisconnect } from '~/_engine/stream-durable/types.ts';
import type { Primitive } from '~/primitive.ts';
import type { Validator } from '~/types.ts';

const RESUMABLE_STREAM_KEY = Symbol('resumable-stream');
const RESUMABLE_STREAM_GENERATE_KEY = Symbol('resumable-stream-generate');

/** Compiled resumable-stream primitive — paired with the generator handler. */
export interface ResumableStreamGeneratePrimitive extends Primitive<'resumable-stream-generate'> {
  readonly event: string;
  readonly validator?: Validator<unknown>;
  readonly generator: (ctx: any, payload: any) => AsyncGenerator<unknown, void, unknown>;
  readonly allowConcurrent: boolean;
  readonly onDisconnect: OnDisconnect;
  readonly maxAgeMs: number;
  readonly retentionAfterEndMs: number;
}

export interface BuildResumableStreamGenerateInput {
  event: string;
  validator?: Validator<unknown>;
  generator: (ctx: any, payload: any) => AsyncGenerator<unknown, void, unknown>;
  allowConcurrent?: boolean;
  onDisconnect?: OnDisconnect;
  maxAgeMs: number;
  retentionAfterEndMs: number;
}

export function resumableGenerateFactory(
  input: BuildResumableStreamGenerateInput,
): ResumableStreamGeneratePrimitive {
  return {
    __wskit: 'resumable-stream-generate',
    __kind: 'handler',
    __identity: [RESUMABLE_STREAM_GENERATE_KEY, input.event],
    __requires: { storage: true, timers: true },
    event: input.event,
    validator: input.validator,
    generator: input.generator,
    allowConcurrent: input.allowConcurrent ?? false,
    onDisconnect: input.onDisconnect ?? 'cancel-but-buffer',
    maxAgeMs: input.maxAgeMs,
    retentionAfterEndMs: input.retentionAfterEndMs,
  };
}

resumableGenerateFactory.__key = RESUMABLE_STREAM_GENERATE_KEY;

/** Identity-only handle for `dependencies: [resumableStreamFactory]` on modules. */
export const resumableStreamFactory = {
  __key: RESUMABLE_STREAM_KEY,
} as const;
