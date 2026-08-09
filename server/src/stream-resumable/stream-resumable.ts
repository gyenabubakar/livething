/* oxlint-disable @typescript-eslint/no-explicit-any */
import { CAPABILITY_KIND } from '~/_define/capability-kinds.ts';
import type { OnDisconnect } from '~/_engine/stream-durable/types.ts';
import type { Primitive } from '~/primitive.ts';
import type { Validator } from '~/types.ts';

const RESUMABLE_STREAM_KEY = Symbol('resumable-stream');
const RESUMABLE_STREAM_GENERATE_KEY = Symbol('resumable-stream-generate');

/** One declared nudge on a durable stream — wire event name + payload validator. */
export interface DurableNudgeDeclaration {
  readonly event: string;
  readonly validator?: Validator<unknown>;
}

/**
 * Compiled resumable-stream primitive — the contract declaration plus the
 * generator function, ready for the engine to mount. Produced by
 * `compileResumableStreamDef`. Library users do not touch this directly.
 */
export interface ResumableStreamGeneratePrimitive extends Primitive<'resumable-stream-generate'> {
  readonly event: string;
  readonly validator?: Validator<unknown>;
  readonly cursor?: Validator<unknown>;
  readonly generator: (ctx: any, payload: any) => AsyncGenerator<unknown, void, unknown>;
  readonly allowConcurrent: boolean;
  readonly broadcast: boolean;
  readonly onDisconnect: OnDisconnect;
  readonly nudges: readonly DurableNudgeDeclaration[];
  readonly maxAgeMs: number;
  readonly retentionAfterEndMs: number;
  /** Outbound backpressure limit in bytes used by `ctx.stream.drain()`. Undefined = default 256 KB. */
  readonly highWaterMark?: number;
}

/** Inputs accepted by `resumableGenerateFactory`. */
export interface BuildResumableStreamGenerateInput {
  event: string;
  validator?: Validator<unknown>;
  cursor?: Validator<unknown>;
  generator: (ctx: any, payload: any) => AsyncGenerator<unknown, void, unknown>;
  allowConcurrent?: boolean;
  broadcast?: boolean;
  onDisconnect?: OnDisconnect;
  nudges?: readonly DurableNudgeDeclaration[];
  maxAgeMs: number;
  retentionAfterEndMs: number;
  highWaterMark?: number;
}

/** Build the runtime primitive used by the engine to mount one resumable stream. */
export function resumableGenerateFactory(
  input: BuildResumableStreamGenerateInput,
): ResumableStreamGeneratePrimitive {
  return {
    __wskit: 'resumable-stream-generate',
    __kind: 'handler',
    __identity: [RESUMABLE_STREAM_GENERATE_KEY, input.event],
    __requires: {},
    __requiresCapabilities: [CAPABILITY_KIND.persistence],
    event: input.event,
    validator: input.validator,
    cursor: input.cursor,
    generator: input.generator,
    allowConcurrent: input.allowConcurrent ?? false,
    broadcast: input.broadcast ?? false,
    onDisconnect: input.onDisconnect ?? 'cancel-but-buffer',
    nudges: input.nudges ?? [],
    maxAgeMs: input.maxAgeMs,
    retentionAfterEndMs: input.retentionAfterEndMs,
    highWaterMark: input.highWaterMark,
  };
}

resumableGenerateFactory.__key = RESUMABLE_STREAM_GENERATE_KEY;

/** Identity-only handle for `dependencies: [resumableStreamFactory]` on plugins. */
export const resumableStreamFactory = {
  __key: RESUMABLE_STREAM_KEY,
} as const;
