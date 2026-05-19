/* oxlint-disable @typescript-eslint/no-explicit-any */
import { assertNonReservedEventName } from '~/_engine/compile/utils.ts';
import type { NudgeDef } from '~/stream/definition.ts';
import type { Validator } from '~/types.ts';

/**
 * What happens to the generator when the owning connection drops while a
 * durable stream is still running.
 *
 * - `'cancel-but-buffer'` (default) — the framework calls `generator.return()`.
 *   Production stops; the cursor/buffer is preserved for resume.
 * - `'keep-running'` — the framework leaves the generator alone. It keeps
 *   yielding into the buffer (recordedStream) or moving the cursor forward
 *   (resumableStream) with no client attached. Use sparingly — server
 *   resources stay open until the generator finishes on its own or the
 *   retention window elapses.
 */
export type OnDisconnect = 'cancel-but-buffer' | 'keep-running';

interface CommonDurableConfig {
  onDisconnect?: OnDisconnect;
  /**
   * How long a suspended stream is kept around after the owning connection
   * drops, before the sweeper deletes it. Default: 5 minutes.
   */
  maxAgeMs?: number;
  /**
   * How long an ended stream is kept around after `_streamEnd`, so a client
   * that reconnects briefly afterwards can still pick up the tail. Default:
   * 30 seconds.
   */
  retentionAfterEndMs?: number;
}

/**
 * Contract-side declaration of a server-pushed stream that re-runs its
 * generator with a saved cursor on resume. Produced by `resumableStream()`.
 *
 * The matching generator is attached later via
 * `.resumableStream(name, async function* (ctx, payload) { ... })`. Inside the
 * generator, `ctx.stream.cursor` holds the last cursor value (or `null` on
 * first run); `ctx.stream.withCursor(chunk, cursor)` is the yield helper that
 * records each cursor as chunks are emitted.
 */
export interface ResumableStreamDef<
  TName extends string = string,
  TPayload = unknown,
  TChunk = unknown,
  TCursor = unknown,
  TNudges extends readonly NudgeDef<string, any>[] = readonly NudgeDef<string, any>[],
> extends CommonDurableConfig {
  readonly _: 'resumable-stream';
  readonly name: TName;
  readonly payload?: Validator<TPayload>;
  readonly chunk?: Validator<TChunk>;
  readonly nudges: TNudges;
  readonly allowConcurrent: boolean;
  readonly __cursorPhantom?: TCursor;
}

/**
 * Contract-side declaration of a server-pushed stream that buffers every
 * emitted chunk in storage; on reconnect the server replays missed chunks
 * (those with `seq > since`). Produced by `recordedStream()`. The generator
 * itself does NOT re-run on resume.
 */
export interface RecordedStreamDef<
  TName extends string = string,
  TPayload = unknown,
  TChunk = unknown,
  TNudges extends readonly NudgeDef<string, any>[] = readonly NudgeDef<string, any>[],
> extends CommonDurableConfig {
  readonly _: 'recorded-stream';
  readonly name: TName;
  readonly payload?: Validator<TPayload>;
  readonly chunk?: Validator<TChunk>;
  readonly nudges: TNudges;
  readonly allowConcurrent: boolean;
  /** Maximum chunks kept in the buffer. Default: 500. */
  readonly maxChunks: number;
}

interface ResumableStreamConfig<
  TPayload,
  TChunk,
  TCursor,
  TNudges extends readonly NudgeDef<string, any>[],
> extends CommonDurableConfig {
  payload?: Validator<TPayload>;
  chunk?: Validator<TChunk>;
  nudges?: TNudges;
  allowConcurrent?: boolean;
  /**
   * Phantom marker that pins the cursor type. Not required — TS infers `unknown`
   * if omitted. Use when you want stronger typing on `ctx.stream.cursor`.
   */
  cursor?: () => TCursor;
}

interface RecordedStreamConfig<
  TPayload,
  TChunk,
  TNudges extends readonly NudgeDef<string, any>[],
> extends CommonDurableConfig {
  payload?: Validator<TPayload>;
  chunk?: Validator<TChunk>;
  nudges?: TNudges;
  allowConcurrent?: boolean;
  /** Maximum chunks kept in the buffer. Default: 500. */
  maxChunks?: number;
}

/**
 * Declare a server-pushed stream that survives client disconnects by
 * re-running the generator from a saved cursor on resume.
 *
 * The generator gets `ctx.stream.cursor` (the last cursor value, or `null`
 * on first run) and `ctx.stream.attempt` (1 first, 2+ on resume). Use
 * `ctx.stream.withCursor(chunk, cursor)` to yield a chunk together with the
 * cursor the framework should persist.
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

/**
 * Declare a server-pushed stream that buffers every emitted chunk in
 * storage; on reconnect the server replays the chunks the client missed.
 *
 * Best for non-resumable sources (LLM tokens, third-party APIs, anything
 * where re-invoking the generator would not produce the same chunks).
 *
 * If the buffer hits `maxChunks` the framework throws `StreamAborted`
 * with `reason: 'buffer-full'` into the generator's `yield`; wrap the yield
 * in `try/catch` to handle it (return early, downgrade, etc.). If unhandled
 * the error surfaces to the client and the stream ends.
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
    onDisconnect: config?.onDisconnect ?? 'cancel-but-buffer',
    maxAgeMs: config?.maxAgeMs ?? 5 * 60_000,
    retentionAfterEndMs: config?.retentionAfterEndMs ?? 30_000,
    maxChunks: config?.maxChunks ?? 500,
  };
}

// Phantom-marker for `ctx.stream.withCursor(chunk, cursor)` returns. The
// runtime unwraps this before sending the chunk on the wire and persists
// the cursor.
export const CURSOR_MARK = Symbol('wskit:cursor');

export interface CursorChunk<TChunk = unknown, TCursor = unknown> {
  readonly [CURSOR_MARK]: true;
  readonly chunk: TChunk;
  readonly cursor: TCursor;
}

export function isCursorChunk(value: unknown): value is CursorChunk {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[CURSOR_MARK] === true
  );
}

export function makeCursorChunk<TChunk, TCursor>(
  chunk: TChunk,
  cursor: TCursor,
): CursorChunk<TChunk, TCursor> {
  return { [CURSOR_MARK]: true, chunk, cursor };
}
