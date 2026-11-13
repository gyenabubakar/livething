/* oxlint-disable @typescript-eslint/no-explicit-any */
import { collectUnique } from '~/_engine/compile/utils.ts';
import { assertNonReservedEventName } from '~/event-name.ts';
import { DURABLE_STREAM_DEFAULTS, validateDurableStreamConfig } from '~/stream/durable-config.ts';
import type { NudgeDef } from '~/stream/definition.ts';
import type { CommonDurableStreamConfig } from '~/stream/durable-config.ts';
import type { Validator } from '~/types.ts';

/**
 * Contract-side declaration produced internally when you register a stream with
 * `base.recordedStream(...)`.
 */
export interface RecordedStreamDef<
  TName extends string = string,
  TPayload = unknown,
  TNudges extends readonly NudgeDef<string, any>[] = readonly NudgeDef<string, any>[],
> extends CommonDurableStreamConfig {
  readonly _: 'recorded-stream';
  readonly name: TName;
  readonly payload?: Validator<TPayload>;
  readonly nudges: TNudges;
  readonly allowConcurrent: boolean;
  readonly broadcast: boolean;
  /** Maximum chunks kept in the buffer. Default: 500. */
  readonly maxChunks: number;
  /** Maximum bytes kept in the buffer. Default: 64 MiB. */
  readonly maxBufferBytes: number;
}

interface RecordedStreamConfig<
  TPayload,
  TNudges extends readonly NudgeDef<string, any>[],
> extends CommonDurableStreamConfig {
  payload?: Validator<TPayload>;
  nudges?: TNudges;
  allowConcurrent?: boolean;
  /** Maximum chunks kept in the buffer. Default: 500. */
  maxChunks?: number;
  /**
   * Maximum bytes kept in the buffer: the UTF-8 bytes of each chunk's JSON (or a binary
   * chunk's info), plus a binary chunk's bytes. Default: 64 MiB.
   */
  maxBufferBytes?: number;
}

/** The default `maxBufferBytes` of a recorded stream, the same as replay's `retention.maxBytes`. */
const DEFAULT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/**
 * Declare a server-pushed stream whose chunks are buffered in storage so a
 * reconnecting client can replay what it missed. The generator keeps running
 * when its client drops and never re-runs — the client just receives the
 * chunks it missed from the buffer. Best for one-shot sources (LLM tokens,
 * third-party APIs).
 *
 * If the buffer hits `maxChunks` or `maxBufferBytes`, or one chunk is too big
 * to store or send, the framework throws `StreamAborted` with
 * `reason: 'buffer-full'` into the generator's `yield`. That chunk is not
 * stored or sent. Wrap the yield in `try/catch` if you want to handle it
 * gracefully.
 *
 * Nudges declared here behave exactly like nudges on a plain `stream(...)`.
 * The generator keeps the nudges it already received when the client
 * reconnects.
 *
 * @example
 * ```ts
 * import { server } from '@livething/server';
 * import { StreamAborted } from '@livething/server/errors';
 * import { recordedStream } from '@livething/server/streams';
 * import * as v from 'valibot';
 *
 * const base = server({
 *   capabilities: [recordedStream()],
 * });
 *
 * const handleCountTokens = base.recordedStream('count-tokens', {
 *   input: v.object({}),
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
  const TNudges extends readonly NudgeDef<string, any>[] = readonly [],
>(
  name: TName,
  config?: RecordedStreamConfig<TPayload, TNudges>,
): RecordedStreamDef<TName, TPayload, TNudges> {
  assertNonReservedEventName(name, 'recordedStream');
  const context = `recordedStream("${name}")`;
  validateDurableStreamConfig(config, context, { maxChunks: true });

  const nudges = (config?.nudges ?? []) as TNudges;
  collectUnique(nudges, (n) => n.name, { kind: 'nudge', context });

  return {
    _: 'recorded-stream',
    name,
    payload: config?.payload,
    nudges,
    allowConcurrent: config?.allowConcurrent ?? false,
    broadcast: config?.broadcast ?? false,
    maxAgeMs: config?.maxAgeMs ?? DURABLE_STREAM_DEFAULTS.maxAgeMs,
    retentionAfterEndMs: config?.retentionAfterEndMs ?? DURABLE_STREAM_DEFAULTS.retentionAfterEndMs,
    maxChunks: config?.maxChunks ?? 500,
    maxBufferBytes: config?.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES,
  };
}
