/* oxlint-disable @typescript-eslint/no-explicit-any */
import { assertNonReservedEventName } from '~/_engine/compile/utils.ts';
import type { OnDisconnect } from '~/_engine/stream-durable/types.ts';
import type { NudgeDef } from '~/stream/definition.ts';
import type { Validator } from '~/types.ts';

export type { OnDisconnect };

interface CommonResumableConfig {
  onDisconnect?: OnDisconnect;
  /** How long a suspended stream is kept after the owning connection drops. Default: 5 minutes. */
  maxAgeMs?: number;
  /** How long an ended stream is kept after `_streamEnd` so a quick reconnect can still resume. Default: 30 seconds. */
  retentionAfterEndMs?: number;
}

/**
 * Contract-side declaration of a server-pushed stream that re-runs its
 * generator with a saved cursor on resume. Produced by `resumableStream()`.
 *
 * Inside the generator, `ctx.stream.cursor` holds the last cursor value
 * (`null` on first run). `ctx.stream.withCursor(chunk, cursor)` is the yield
 * helper that records each cursor as chunks are emitted.
 */
export interface ResumableStreamDef<
  TName extends string = string,
  TPayload = unknown,
  TChunk = unknown,
  TCursor = unknown,
  TNudges extends readonly NudgeDef<string, any>[] = readonly NudgeDef<string, any>[],
> extends CommonResumableConfig {
  readonly _: 'resumable-stream';
  readonly name: TName;
  readonly payload?: Validator<TPayload>;
  readonly chunk?: Validator<TChunk>;
  readonly nudges: TNudges;
  readonly allowConcurrent: boolean;
  readonly __cursorPhantom?: TCursor;
}

interface ResumableStreamConfig<
  TPayload,
  TChunk,
  TCursor,
  TNudges extends readonly NudgeDef<string, any>[],
> extends CommonResumableConfig {
  payload?: Validator<TPayload>;
  chunk?: Validator<TChunk>;
  nudges?: TNudges;
  allowConcurrent?: boolean;
  /**
   * Phantom marker that pins the cursor type. Not required — TS infers
   * `unknown` if omitted. Use when you want stronger typing on
   * `ctx.stream.cursor`.
   */
  cursor?: () => TCursor;
}

/**
 * Declare a server-pushed stream that survives client disconnects by
 * re-running the generator from a saved cursor on resume.
 *
 * Requires `persistence: true` on the contract. Build throws otherwise.
 */
export function resumableStream<
  TName extends string,
  TPayload = unknown,
  TChunk = unknown,
  TCursor = unknown,
  const TNudges extends readonly NudgeDef<string, any>[] = readonly [],
>(
  name: TName,
  config?: ResumableStreamConfig<TPayload, TChunk, TCursor, TNudges>,
): ResumableStreamDef<TName, TPayload, TChunk, TCursor, TNudges> {
  assertNonReservedEventName(name, 'resumableStream');
  return {
    _: 'resumable-stream',
    name,
    payload: config?.payload,
    chunk: config?.chunk,
    nudges: (config?.nudges ?? []) as TNudges,
    allowConcurrent: config?.allowConcurrent ?? false,
    onDisconnect: config?.onDisconnect ?? 'cancel-but-buffer',
    maxAgeMs: config?.maxAgeMs ?? 5 * 60_000,
    retentionAfterEndMs: config?.retentionAfterEndMs ?? 30_000,
  };
}
