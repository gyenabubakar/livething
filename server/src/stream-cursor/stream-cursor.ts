/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { OnDisconnect } from '~/_engine/stream-durable/types.ts';
import type { Primitive } from '~/primitive.ts';
import type { Validator } from '~/types.ts';

const CURSOR_STREAM_KEY = Symbol('cursor-stream');
const CURSOR_STREAM_GENERATE_KEY = Symbol('cursor-stream-generate');

/** One declared nudge on a durable stream — wire event name + payload validator. */
export interface DurableNudgeDeclaration {
  readonly event: string;
  readonly validator?: Validator<unknown>;
}

/**
 * Compiled cursor-stream primitive — the contract declaration plus the
 * generator function, ready for the engine to mount. Produced by
 * `compileCursorStreamDef`. Library users do not touch this directly.
 */
export interface CursorStreamGeneratePrimitive extends Primitive<'cursor-stream-generate'> {
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

/** Inputs accepted by `cursorGenerateFactory`. */
export interface BuildCursorStreamGenerateInput {
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

/** Build the runtime primitive used by the engine to mount one cursor stream. */
export function cursorGenerateFactory(
  input: BuildCursorStreamGenerateInput,
): CursorStreamGeneratePrimitive {
  return {
    __livething: 'cursor-stream-generate',
    __kind: 'handler',
    __identity: [CURSOR_STREAM_GENERATE_KEY, input.event],
    __requires: {},
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

cursorGenerateFactory.__key = CURSOR_STREAM_GENERATE_KEY;

/** Identity-only handle for `dependencies: [cursorStreamFactory]` on plugins. */
export const cursorStreamFactory = {
  __key: CURSOR_STREAM_KEY,
} as const;
