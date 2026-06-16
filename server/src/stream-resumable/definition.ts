/* oxlint-disable @typescript-eslint/no-explicit-any */
import { assertNonReservedEventName, collectUnique } from '~/_engine/compile/utils.ts';
import { assertOneOf, assertOptionalPositiveInteger } from '~/_engine/validation.ts';
import type { OnDisconnect } from '~/_engine/stream-durable/types.ts';
import type { NudgeDef } from '~/stream/definition.ts';
import type { Validator } from '~/types.ts';

export type { OnDisconnect };

interface CommonResumableConfig {
  onDisconnect?: OnDisconnect;
  /** How long a suspended stream is kept after the owning connection drops. Default: 5 minutes. */
  maxAgeMs?: number;
  /** How long an ended stream is kept after `__streamEnd__` so a quick reconnect can still resume. Default: 30 seconds. */
  retentionAfterEndMs?: number;
  /**
   * One generator, many subscribers. The creator runs the cursor-driven
   * generator once; every chunk is buffered, fanned out to scope members,
   * and the cursor is saved for crash recovery. Subscribers catch up from
   * the buffer on resume — they do not re-invoke the generator.
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
   * Hard cap on chunks kept in the broadcast buffer. Only meaningful when
   * `broadcast: true`. Default: 500.
   */
  maxChunks?: number;
  /**
   * Outbound backpressure limit in bytes used by `ctx.stream.drain()`. Defaults
   * to 256 KB.
   */
  highWaterMark?: number;
}

/**
 * Contract-side declaration produced internally when you register a stream with
 * `base.resumableStream(...)`.
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
  readonly cursor?: Validator<TCursor>;
  readonly nudges: TNudges;
  readonly allowConcurrent: boolean;
  readonly broadcast: boolean;
  readonly maxChunks: number;
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
   * Validator for the cursor value. The framework parses every cursor it
   * restores from storage through this validator before handing it to the
   * generator on resume — if the stored value no longer matches the shape
   * (older deploy, tampered row), the resuming client gets
   * `StreamAborted({ reason: 'cursor-invalid' })`. Omit it and `TCursor`
   * stays `unknown` and no runtime check runs.
   */
  cursor?: Validator<TCursor>;
}

/**
 * Declare a server-pushed stream that survives client disconnects by
 * re-running the generator from a saved cursor on resume.
 *
 * Inside the generator, `ctx.stream.cursor` holds the cursor you last
 * recorded (`null` on first run). `ctx.stream.attempt` is `1` on the first
 * run and increments on every resume. Yield chunks via
 * `ctx.stream.withCursor(chunk, cursor)` so the framework persists the
 * cursor alongside the chunk — on reconnect the generator restarts and
 * `ctx.stream.cursor` is set to that recorded value.
 *
 * Nudges declared here behave exactly like nudges on a plain `stream(...)`:
 * the client pushes a typed message into the running generator and the
 * generator reads them via `ctx.nudges(yield ...)`. Buffered nudges survive
 * a resume so a paused durable stream stays paused after reconnect.
 *
 * Requires the `persistence()` capability. Build throws otherwise.
 *
 * Pass a `cursor` validator to pin the cursor type and have the framework
 * runtime-check every cursor it restores from storage. A stored cursor that
 * fails the validator surfaces on the wire as
 * `StreamAborted({ reason: 'cursor-invalid' })` on the resuming client.
 *
 * @example
 * ```ts
 * import { define, t } from '@wskit/server';
 * import { persistence } from '@wskit/server/persistence';
 * import { resumableStream } from '@wskit/server/streams';
 * import * as v from 'valibot';
 *
 * const PaginatePayload = v.object({});
 * const RowChunk = v.object({ row: v.number() });
 * const PaginateCursor = v.object({ idx: v.number() });
 *
 * const base = define({
 *   env: t<Env>(),
 *   capabilities: [persistence(), resumableStream()],
 * });
 *
 * const handlePaginate = base.resumableStream('paginate', {
 *   input: PaginatePayload,
 *   chunk: RowChunk,
 *   cursor: PaginateCursor,
 *   maxAgeMs: 60_000,
 *   retentionAfterEndMs: 30_000,
 *   async *run(ctx) {
 *     const startAt = ctx.stream.cursor?.idx ?? 0;
 *     for (let i = startAt + 1; i <= 10; i += 1) {
 *       yield ctx.stream.withCursor({ row: i }, { idx: i });
 *     }
 *   },
 * });
 * ```
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
  const context = `resumableStream("${name}")`;
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
    _: 'resumable-stream',
    name,
    payload: config?.payload,
    chunk: config?.chunk,
    cursor: config?.cursor,
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
