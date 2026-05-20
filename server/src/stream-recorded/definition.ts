/* oxlint-disable @typescript-eslint/no-explicit-any */
import { assertNonReservedEventName } from '~/_engine/compile/utils.ts';
import type { OnDisconnect } from '~/_engine/stream-durable/types.ts';
import type { NudgeDef } from '~/stream/definition.ts';
import type { Validator } from '~/types.ts';

export type { OnDisconnect };

interface CommonRecordedConfig {
  onDisconnect?: OnDisconnect;
  /** How long a suspended stream is kept after the owning connection drops. Default: 5 minutes. */
  maxAgeMs?: number;
  /** How long an ended stream is kept after `_streamEnd` so a quick reconnect can still get the tail. Default: 30 seconds. */
  retentionAfterEndMs?: number;
  /**
   * One generator, many subscribers. Chunks fan out to channel members (when
   * declared inside `channel(...)`), to all connections in the namespace (when
   * inside `namespace(...)`), or to every connection (top-level). Late joiners
   * and reconnects catch up from the recorded buffer. Default: false.
   */
  broadcast?: boolean;
}

/**
 * Contract-side declaration of a server-pushed stream that buffers every
 * emitted chunk in storage. On reconnect the framework replays the chunks
 * the client missed. The generator itself does NOT re-run on resume.
 *
 * If the buffer hits `maxChunks` the framework throws `StreamAborted` with
 * `reason: 'buffer-full'` into the generator's `yield`. Wrap the yield in
 * `try/catch` to handle it.
 */
export interface RecordedStreamDef<
  TName extends string = string,
  TPayload = unknown,
  TChunk = unknown,
  TNudges extends readonly NudgeDef<string, any>[] = readonly NudgeDef<string, any>[],
> extends CommonRecordedConfig {
  readonly _: 'recorded-stream';
  readonly name: TName;
  readonly payload?: Validator<TPayload>;
  readonly chunk?: Validator<TChunk>;
  readonly nudges: TNudges;
  readonly allowConcurrent: boolean;
  readonly broadcast: boolean;
  /** Maximum chunks kept in the buffer. Default: 500. */
  readonly maxChunks: number;
}

interface RecordedStreamConfig<
  TPayload,
  TChunk,
  TNudges extends readonly NudgeDef<string, any>[],
> extends CommonRecordedConfig {
  payload?: Validator<TPayload>;
  chunk?: Validator<TChunk>;
  nudges?: TNudges;
  allowConcurrent?: boolean;
  /** Maximum chunks kept in the buffer. Default: 500. */
  maxChunks?: number;
}

/**
 * Declare a server-pushed stream whose chunks are buffered in storage so a
 * reconnecting client can replay what it missed.
 *
 * Requires `persistence: true` on the contract. Build throws otherwise.
 */
export function recordedStream<
  TName extends string,
  TPayload = unknown,
  TChunk = unknown,
  const TNudges extends readonly NudgeDef<string, any>[] = readonly [],
>(
  name: TName,
  config?: RecordedStreamConfig<TPayload, TChunk, TNudges>,
): RecordedStreamDef<TName, TPayload, TChunk, TNudges> {
  assertNonReservedEventName(name, 'recordedStream');
  return {
    _: 'recorded-stream',
    name,
    payload: config?.payload,
    chunk: config?.chunk,
    nudges: (config?.nudges ?? []) as TNudges,
    allowConcurrent: config?.allowConcurrent ?? false,
    broadcast: config?.broadcast ?? false,
    onDisconnect: config?.onDisconnect ?? 'cancel-but-buffer',
    maxAgeMs: config?.maxAgeMs ?? 5 * 60_000,
    retentionAfterEndMs: config?.retentionAfterEndMs ?? 30_000,
    maxChunks: config?.maxChunks ?? 500,
  };
}
