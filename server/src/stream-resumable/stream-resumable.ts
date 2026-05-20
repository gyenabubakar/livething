/* oxlint-disable @typescript-eslint/no-explicit-any */
/**
 * Primitive factory for `resumableStream(...)`. The compile path produces
 * exactly one primitive — the handler-bound one with tag
 * `'resumable-stream-generate'` — which lands in
 * `compiled.resumableStreams` for the engine dispatcher to find.
 *
 * The declaration factory `resumableStreamFactory` is also exposed so module
 * authors can reference its `__key` symbol in `dependencies: [...]`. It is
 * not pushed at compile time — its only role is to give the feature a
 * stable identity for dependency resolution.
 */

import type { OnDisconnect } from '~/_engine/stream-durable/types.ts';
import type { Primitive } from '~/primitive.ts';
import type { Validator } from '~/types.ts';

const RESUMABLE_STREAM_KEY = Symbol('resumable-stream');
const RESUMABLE_STREAM_GENERATE_KEY = Symbol('resumable-stream-generate');

/**
 * Compiled resumable-stream primitive. Carries the trigger event, the
 * generator function, and the durable-stream config the engine needs at
 * runtime (cursor mode, retention windows, on-disconnect policy).
 */
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

/**
 * Build the runtime primitive paired with a resumable-stream handler. The
 * engine dispatcher routes incoming trigger frames whose event matches
 * `event` into the durable-stream runtime in resumable mode.
 */
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

/**
 * Identity-only declaration factory. Reserved for module-side dependency
 * declarations (`dependencies: [resumableStreamFactory]`). Not pushed as a
 * runtime primitive during compile.
 */
export const resumableStreamFactory = {
  __key: RESUMABLE_STREAM_KEY,
} as const;
