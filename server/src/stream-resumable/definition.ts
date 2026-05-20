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
  /**
   * One generator, many subscribers. The creator runs the cursor-driven
   * generator once; every chunk is buffered, fanned out to scope members,
   * and the cursor is saved for crash recovery. Subscribers catch up from
   * the buffer on resume — they do not re-invoke the generator.
   *
   * Scope is decided by where you declare the stream:
   * - Top-level — fans out to every connection on the handler.
   * - Inside `namespace(...)` — fans out to every connection in that namespace.
   * - Inside `channel(...)` — fans out to every connection subscribed to the channel.
   *
   * A non-creator that sends `_streamCancel` is unsubscribed from future
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
}

/**
 * Contract-side declaration produced by `resumableStream()`. Pass it into
 * a contract's `definitions: [...]` array.
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
  readonly broadcast: boolean;
  readonly maxChunks: number;
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
 * Requires `persistence: true` on the contract. Build throws otherwise.
 *
 * @example
 * ```ts
 * import { contract, recordedStream, resumableStream, t } from '@wskit/server';
 * import * as v from 'valibot';
 *
 * const PaginatePayload = v.object({});
 * const RowChunk = v.object({ row: v.number() });
 *
 * const myContract = contract<Env>('files')({
 *   persistence: true,
 *   definitions: [
 *     resumableStream('paginate', {
 *       payload: PaginatePayload,
 *       chunk: RowChunk,
 *       maxAgeMs: 60_000,
 *       retentionAfterEndMs: 30_000,
 *     }),
 *   ],
 * });
 *
 * // In the handler:
 * implement(myContract).resumableStream('paginate', async function* (ctx) {
 *   const startAt = (ctx.stream.cursor as { idx: number } | null)?.idx ?? 0;
 *   for (let i = startAt + 1; i <= 10; i += 1) {
 *     yield ctx.stream.withCursor({ row: i }, { idx: i });
 *   }
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
  return {
    _: 'resumable-stream',
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
