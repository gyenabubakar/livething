/* oxlint-disable @typescript-eslint/no-explicit-any */
import { collectUnique } from '~/_engine/compile/utils.ts';
import { assertNonReservedEventName } from '~/event-name.ts';
import { DURABLE_STREAM_DEFAULTS, validateDurableStreamConfig } from '~/stream/durable-config.ts';
import type { TypeMarker } from '~/_api/definitions.ts';
import type { OnDisconnect } from '~/_engine/stream-durable/types.ts';
import type { NudgeDef } from '~/stream/definition.ts';
import type { CommonDurableStreamConfig } from '~/stream/durable-config.ts';
import type { Validator } from '~/types.ts';

export type { OnDisconnect };

/**
 * Contract-side declaration produced internally when you register a stream with
 * `base.recordedStream(...)`.
 */
export interface RecordedStreamDef<
  TName extends string = string,
  TPayload = unknown,
  TChunk = unknown,
  TNudges extends readonly NudgeDef<string, any>[] = readonly NudgeDef<string, any>[],
> extends CommonDurableStreamConfig {
  readonly _: 'recorded-stream';
  readonly name: TName;
  readonly payload?: Validator<TPayload>;
  readonly chunk?: TypeMarker<TChunk>;
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
> extends CommonDurableStreamConfig {
  payload?: Validator<TPayload>;
  chunk?: TypeMarker<TChunk>;
  nudges?: TNudges;
  allowConcurrent?: boolean;
  /** Maximum chunks kept in the buffer. Default: 500. */
  maxChunks?: number;
}

/**
 * Declare a server-pushed stream whose chunks are buffered in storage so a
 * reconnecting client can replay what it missed. Unlike `resumableStream`,
 * the generator does NOT re-run on resume — the client just receives the
 * chunks it missed from the buffer. Best for non-resumable sources (LLM
 * tokens, third-party APIs).
 *
 * If the buffer hits `maxChunks` the framework throws `StreamAborted` with
 * `reason: 'buffer-full'` into the generator's `yield`. Wrap the yield in
 * `try/catch` if you want to handle it gracefully.
 *
 * Nudges declared here behave exactly like nudges on a plain `stream(...)`.
 * The generator never re-runs, so with `onDisconnect: 'keep-running'` it
 * keeps the nudges it already received when the client reconnects.
 *
 * @example
 * ```ts
 * import { server, t } from '@livething/server';
 * import { StreamAborted } from '@livething/server/errors';
 * import { recordedStream } from '@livething/server/streams';
 * import * as v from 'valibot';
 *
 * const TokenChunk = t<{ idx: number }>();
 *
 * const base = server({
 *   capabilities: [recordedStream()],
 * });
 *
 * const handleCountTokens = base.recordedStream('count-tokens', {
 *   input: v.object({}),
 *   chunk: TokenChunk,
 *   maxChunks: 100,
 *   maxAgeMs: 60_000,
 *   retentionAfterEndMs: 30_000,
 *   async *run() {
 *     for (let i = 1; i <= 5; i += 1) {
 *       try {
 *         yield { idx: i };
 *       } catch (err) {
 *         if (StreamAborted.matches(err) && err.detail.reason === 'buffer-full') return;
 *         throw err;
 *       }
 *     }
 *   },
 * });
 * ```
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
  const context = `recordedStream("${name}")`;
  validateDurableStreamConfig(config, context, { maxChunks: true });

  const nudges = (config?.nudges ?? []) as TNudges;
  collectUnique(nudges, (n) => n.name, { kind: 'nudge', context });

  return {
    _: 'recorded-stream',
    name,
    payload: config?.payload,
    chunk: config?.chunk,
    nudges,
    allowConcurrent: config?.allowConcurrent ?? false,
    broadcast: config?.broadcast ?? false,
    onDisconnect: config?.onDisconnect ?? DURABLE_STREAM_DEFAULTS.onDisconnect,
    maxAgeMs: config?.maxAgeMs ?? DURABLE_STREAM_DEFAULTS.maxAgeMs,
    retentionAfterEndMs: config?.retentionAfterEndMs ?? DURABLE_STREAM_DEFAULTS.retentionAfterEndMs,
    maxChunks: config?.maxChunks ?? 500,
    highWaterMark: config?.highWaterMark,
  };
}
