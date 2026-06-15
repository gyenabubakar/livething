/* oxlint-disable @typescript-eslint/no-explicit-any */
import { assertNonReservedEventName, collectUnique } from '~/_engine/compile/utils.ts';
import { assertOneOf, assertOptionalPositiveInteger } from '~/_engine/validation.ts';
import type { OnDisconnect } from '~/_engine/stream-durable/types.ts';
import type { NudgeDef } from '~/stream/definition.ts';
import type { Validator } from '~/types.ts';

export type { OnDisconnect };

interface CommonRecordedConfig {
  onDisconnect?: OnDisconnect;
  /** How long a suspended stream is kept after the owning connection drops. Default: 5 minutes. */
  maxAgeMs?: number;
  /** How long an ended stream is kept after `__streamEnd__` so a quick reconnect can still get the tail. Default: 30 seconds. */
  retentionAfterEndMs?: number;
  /**
   * One generator, many subscribers. The creator runs the generator once;
   * every chunk lands in the buffer and fans out to scope members. Late
   * joiners and reconnects catch up from the recorded buffer.
   *
   * Scope is decided by where you declare the stream:
   * - Top-level — fans out to every connection on the handler.
   * - Inside `channel(...)` — fans out to every connection subscribed to the channel.
   *
   * A non-creator that sends `__streamCancel__` is unsubscribed from future
   * chunks for that stream id (its later resume returns `StreamAborted` with
   * `reason: 'unsubscribed'`). The stream itself keeps running for everyone
   * else. A cancel from the creator identity tears the whole stream down.
   *
   * Default: false.
   */
  broadcast?: boolean;
  /**
   * Outbound backpressure limit in bytes used by `ctx.stream.drain()`. Defaults
   * to 256 KB.
   */
  highWaterMark?: number;
}

/**
 * Contract-side declaration produced by `recordedStream()`. Pass it into a
 * contract's `definitions: [...]` array.
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
 * reconnecting client can replay what it missed. Unlike `resumableStream`,
 * the generator does NOT re-run on resume — the client just receives the
 * chunks it missed from the buffer. Best for non-resumable sources (LLM
 * tokens, third-party APIs).
 *
 * If the buffer hits `maxChunks` the framework throws `StreamAborted` with
 * `reason: 'buffer-full'` into the generator's `yield`. Wrap the yield in
 * `try/catch` if you want to handle it gracefully.
 *
 * Nudges declared here behave exactly like nudges on a plain `stream(...)`
 * and survive a resume.
 *
 * Requires `persistence: true` on the contract. Build throws otherwise.
 *
 * @example
 * ```ts
 * import { contract, recordedStream } from '@wskit/server';
 * import { StreamAborted } from '@wskit/server/errors';
 * import * as v from 'valibot';
 *
 * const TokenChunk = v.object({ idx: v.number() });
 *
 * const myContract = contract('ai', { env: t<Env>(),
 *   persistence: true,
 *   definitions: [
 *     recordedStream('count-tokens', {
 *       payload: v.object({}),
 *       chunk: TokenChunk,
 *       maxChunks: 100,
 *       maxAgeMs: 60_000,
 *       retentionAfterEndMs: 30_000,
 *     }),
 *   ],
 * });
 *
 * // In the handler:
 * implement(myContract).recordedStream('count-tokens', async function* () {
 *   for (let i = 1; i <= 5; i += 1) {
 *     try {
 *       yield { idx: i };
 *     } catch (err) {
 *       if (StreamAborted.matches(err) && err.detail.reason === 'buffer-full') return;
 *       throw err;
 *     }
 *   }
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
  assertOptionalPositiveInteger(config?.maxAgeMs, 'maxAgeMs', context);
  assertOptionalPositiveInteger(config?.retentionAfterEndMs, 'retentionAfterEndMs', context);
  assertOptionalPositiveInteger(config?.maxChunks, 'maxChunks', context);
  if (config?.onDisconnect !== undefined) {
    assertOneOf(config.onDisconnect, ['cancel-but-buffer', 'keep-running'] as const, {
      field: 'onDisconnect',
      context,
    });
  }
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
    onDisconnect: config?.onDisconnect ?? 'cancel-but-buffer',
    maxAgeMs: config?.maxAgeMs ?? 5 * 60_000,
    retentionAfterEndMs: config?.retentionAfterEndMs ?? 30_000,
    maxChunks: config?.maxChunks ?? 500,
    highWaterMark: config?.highWaterMark,
  };
}
