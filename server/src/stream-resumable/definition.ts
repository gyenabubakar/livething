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
 * `base.resumableStream(...)`.
 */
export interface ResumableStreamDef<
  TName extends string = string,
  TPayload = unknown,
  TChunk = unknown,
  TCursor = unknown,
  TNudges extends readonly NudgeDef<string, any>[] = readonly NudgeDef<string, any>[],
> extends CommonDurableStreamConfig {
  readonly _: 'resumable-stream';
  readonly name: TName;
  readonly payload?: Validator<TPayload>;
  readonly chunk?: TypeMarker<TChunk>;
  readonly cursor?: Validator<TCursor>;
  readonly nudges: TNudges;
  readonly allowConcurrent: boolean;
  readonly broadcast: boolean;
}

interface ResumableStreamConfig<
  TPayload,
  TChunk,
  TCursor,
  TNudges extends readonly NudgeDef<string, any>[],
> extends CommonDurableStreamConfig {
  payload?: Validator<TPayload>;
  chunk?: TypeMarker<TChunk>;
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
 * re-running the generator from the last cursor checkpoint the client
 * confirmed receiving.
 *
 * Inside the generator, `ctx.stream.cursor` holds the last confirmed cursor
 * checkpoint (`null` on first run). `ctx.stream.attempt` is `1` on the first
 * run and goes up by one on every resume that re-runs the generator (`2`,
 * `3`, ...). Yield chunks via
 * `ctx.stream.withCursor(chunk, cursor)` so the framework saves a checkpoint
 * alongside the chunk — on reconnect the generator restarts and
 * `ctx.stream.cursor` is set to that confirmed value.
 *
 * Nudges declared here behave exactly like nudges on a plain `stream(...)`:
 * the client pushes a typed message into the running generator and the
 * generator reads them via `ctx.nudges(yield ...)`. Nudges live only in the
 * running generator: a resume starts a new run with no nudges, and nudges
 * the old run had not read yet are dropped. State that a nudge changes (for
 * example "paused") must go in the cursor if it has to survive a resume.
 *
 * If the stored cursor or trigger payload cannot be restored on resume, the
 * stored stream is deleted and the resuming client gets
 * `StreamAborted({ reason: 'cursor-invalid' })`.
 *
 * Pass a `cursor` validator to pin the cursor type and have the framework
 * runtime-check every checkpoint cursor it restores from storage. A stored
 * cursor that fails the validator surfaces on the wire as
 * `StreamAborted({ reason: 'cursor-invalid' })` on the resuming client.
 *
 * @example
 * ```ts
 * import { server, t } from '@livething/server';
 * import { resumableStream } from '@livething/server/streams';
 * import * as v from 'valibot';
 *
 * const PaginatePayload = v.object({});
 * const RowChunk = t<{ row: number }>();
 * const PaginateCursor = v.object({ idx: v.number() });
 *
 * const base = server({
 *   capabilities: [resumableStream()],
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
  validateDurableStreamConfig(config, context);

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
    onDisconnect: config?.onDisconnect ?? DURABLE_STREAM_DEFAULTS.onDisconnect,
    maxAgeMs: config?.maxAgeMs ?? DURABLE_STREAM_DEFAULTS.maxAgeMs,
    retentionAfterEndMs: config?.retentionAfterEndMs ?? DURABLE_STREAM_DEFAULTS.retentionAfterEndMs,
    highWaterMark: config?.highWaterMark,
  };
}
