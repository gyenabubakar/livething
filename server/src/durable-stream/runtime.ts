/* oxlint-disable @typescript-eslint/no-explicit-any */
/**
 * Runtime for durable streams (resumable + recorded).
 *
 * Layout mirrors `~/stream/runtime.ts`. We deliberately do not extend that
 * file — durable streams have their own bookkeeping (cursor save, chunk
 * append, status transitions) that does not apply to plain streams.
 *
 * v1 scope:
 * - Top-level only. Channel/namespace durable streams are a follow-up.
 * - `onDisconnect: 'cancel-but-buffer'` always (no keep-running).
 * - No broadcast on durable streams.
 * - No nudges on durable streams (declared field tolerated, runtime ignores).
 */

import {
  rethrowIfConfigError,
  StreamAborted,
  StreamAlreadyActive,
  StreamIdCollision,
} from '@wskit/core';
import type {
  ActiveStream,
  ResolvedScope,
  RoutingTarget,
  RuntimeConnection,
} from '~/_engine/runtime/types.ts';
import { isCursorChunk, makeCursorChunk } from './definition.ts';
import * as Storage from './storage.ts';
import type { DurableStreamKind } from './storage.ts';

/** Minimal slice of the engine the durable runtime needs to do its job. */
export interface DurableStreamRuntime {
  activeStreams: Map<string, ActiveStream>;
  generateId(prefix?: string): string;
  logger: { warn(message: string, data?: Record<string, unknown>): void };
  errorHooks: readonly ((ctx: unknown, error: unknown, event?: string) => void | Promise<void>)[];
  buildConnectionContext(
    connection: RuntimeConnection,
    scope?: ResolvedScope,
  ): Record<PropertyKey, unknown>;
  sendProtocolMessage(
    connection: RuntimeConnection,
    event: string,
    payload: Record<string, unknown>,
  ): void;
  sendThroughPipeline(
    connection: RuntimeConnection,
    routing: RoutingTarget | undefined,
    event: string,
    payload: unknown,
  ): boolean;
  setActiveConnectionId(id?: string): void;
  persistAttachment(connection: RuntimeConnection): void;
  /** SQLite handle. Undefined when storage was not configured (engine asserts). */
  sql: {
    exec(query: string, ...params: unknown[]): { toArray(): Record<string, unknown>[] };
  };
  handleRuntimeError(
    connection: RuntimeConnection,
    error: unknown,
    event?: string,
    routing?: Record<string, unknown>,
  ): Promise<void>;
}

/** Snapshot of one durable stream definition relevant to the runtime. */
export interface DurableStreamRuntimeDef {
  readonly event: string;
  readonly kind: DurableStreamKind;
  readonly generator: (ctx: any, payload: any) => AsyncGenerator<unknown, void, unknown>;
  readonly allowConcurrent: boolean;
  readonly maxChunks?: number;
  readonly maxAgeMs?: number;
  readonly retentionAfterEndMs?: number;
}

function readSuppliedStreamId(rawPayload: unknown): string | undefined {
  if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) return undefined;
  const value = (rawPayload as Record<string, unknown>)._streamId;
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) return undefined;
  return value;
}

function ensureUniqueStreamId(
  runtime: DurableStreamRuntime,
  connection: RuntimeConnection,
  streamId: string,
): void {
  if (runtime.activeStreams.has(streamId)) throw StreamIdCollision();
  // Storage-side check guards against id collisions across sockets of the
  // same identity (e.g. user opens the same conversation on two devices).
  const row = Storage.readStream(runtime.sql, connection.identity ?? connection.id, streamId);
  if (row && row.status === 'active') throw StreamIdCollision();
}

/**
 * Start a fresh durable stream. Walks the generator, persists chunks /
 * cursor as they appear, and tears down cleanly on completion or error.
 */
export async function runDurableStream(
  runtime: DurableStreamRuntime,
  connection: RuntimeConnection,
  scope: ResolvedScope,
  def: DurableStreamRuntimeDef,
  payload: unknown,
  rawPayload: unknown,
): Promise<void> {
  const identity = connection.identity ?? connection.id;

  // Concurrency check for same-event on same connection.
  if (!def.allowConcurrent) {
    const existingIds = connection.activeStreamIds;
    if (existingIds) {
      for (const id of existingIds) {
        const existing = runtime.activeStreams.get(id);
        if (existing && !existing.closed && existing.event === def.event) {
          throw StreamAlreadyActive({ event: def.event, _streamId: existing.id });
        }
      }
    }
  }

  const supplied = readSuppliedStreamId(rawPayload);
  const streamId = supplied ?? runtime.generateId('dstream');
  ensureUniqueStreamId(runtime, connection, streamId);

  const now = Date.now();
  Storage.insertStream(runtime.sql, {
    identity,
    streamId,
    event: def.event,
    payload: JSON.stringify(payload ?? null),
    kind: def.kind,
    now,
    maxChunks: def.maxChunks,
    maxAgeMs: def.maxAgeMs,
    retentionAfterEndMs: def.retentionAfterEndMs,
  });

  runtime.sendProtocolMessage(connection, '_streamOk', { _streamId: streamId });

  await runGenerator(runtime, connection, scope, def, payload, streamId, identity, null, 1);
}

/**
 * Resume a previously-suspended (or ended) durable stream on a fresh socket.
 * For recorded streams, replays buffered chunks since `since`. For resumable
 * streams, replays any new chunks (none — see note) then re-invokes the
 * generator with the saved cursor; new chunks emit live.
 *
 * Note: resumable streams do not buffer; replay does nothing for them.
 */
export async function resumeDurableStream(
  runtime: DurableStreamRuntime,
  connection: RuntimeConnection,
  scope: ResolvedScope,
  resolveDef: (event: string) => DurableStreamRuntimeDef | undefined,
  streamId: string,
  since: number,
): Promise<void> {
  const identity = connection.identity ?? connection.id;
  const row = Storage.readStream(runtime.sql, identity, streamId);
  if (!row) {
    runtime.sendProtocolMessage(connection, '_error', {
      code: StreamAborted.code,
      detail: { reason: 'not-found' as const },
      _streamId: streamId,
    });
    return;
  }

  // If the previous socket's close handling is still in flight (the old
  // generator hasn't finished tearing down), wait briefly for it to settle
  // so we don't double-run the generator. The await yields the event loop;
  // the old generator's `finally` will run and clear activeStreams.
  for (let i = 0; runtime.activeStreams.has(streamId) && i < 20; i += 1) {
    await new Promise((r) => setTimeout(r, 25));
  }
  if (runtime.activeStreams.has(streamId)) {
    // Still busy — refuse rather than spawn a second generator.
    runtime.sendProtocolMessage(connection, '_error', {
      code: StreamAborted.code,
      detail: { reason: 'aborted' as const },
      _streamId: streamId,
    });
    return;
  }

  const def = resolveDef(row.event);
  if (!def) {
    runtime.sendProtocolMessage(connection, '_error', {
      code: StreamAborted.code,
      detail: { reason: 'not-found' as const },
      _streamId: streamId,
    });
    return;
  }

  // Replay any buffered chunks the client missed (recorded streams only).
  if (row.kind === 'recorded') {
    const chunks = Storage.readChunksSince(runtime.sql, identity, streamId, since);
    for (const chunk of chunks) {
      const parsed = JSON.parse(chunk.payload);
      const wirePayload: Record<string, unknown> = {
        ...(typeof parsed === 'object' && parsed !== null ? parsed : {}),
        _streamId: streamId,
        _seq: chunk.seq,
      };
      if (chunk.messageId) wirePayload._messageId = chunk.messageId;
      runtime.sendProtocolMessage(connection, def.event, wirePayload);
    }
  }

  if (row.status === 'ended') {
    runtime.sendProtocolMessage(connection, '_streamEnd', {
      _streamId: streamId,
      _seq: row.lastSeq,
    });
    return;
  }

  // status === 'active' or 'suspended' — re-invoke the generator for resumable
  // streams, with the saved cursor. For recorded streams whose generator
  // already ended on disconnect, we have nothing live to continue; the buffer
  // replay above is the whole story, so signal end.
  if (row.kind === 'recorded') {
    Storage.markEnded(runtime.sql, identity, streamId, Date.now());
    runtime.sendProtocolMessage(connection, '_streamEnd', {
      _streamId: streamId,
      _seq: row.lastSeq,
    });
    return;
  }

  // resumable — re-run the generator with the saved cursor.
  const cursor = row.cursor ? JSON.parse(row.cursor) : null;
  const payload = JSON.parse(row.payload);
  runtime.sendProtocolMessage(connection, '_streamOk', { _streamId: streamId });

  // Bump status back to active for the re-run.
  runtime.sql.exec(
    "UPDATE _wskit_streams SET status = 'active', last_activity_at = ? WHERE identity = ? AND stream_id = ?",
    Date.now(),
    identity,
    streamId,
  );

  await runGenerator(runtime, connection, scope, def, payload, streamId, identity, cursor, 2);
}

/**
 * Mark every active durable stream owned by `connection` as suspended.
 * Called from the engine's disconnect path before `cancelActiveStreamsForConnection`
 * tears the in-memory generators down. Once persistence has the suspended
 * row, the client can come back later and resume.
 */
export function markStreamsSuspendedForConnection(
  runtime: { sql: DurableStreamRuntime['sql']; activeStreams: Map<string, ActiveStream> },
  connection: RuntimeConnection,
): void {
  const identity = connection.identity ?? connection.id;
  const now = Date.now();
  for (const active of runtime.activeStreams.values()) {
    if (active.connectionId !== connection.id) continue;
    Storage.markSuspended(runtime.sql, identity, active.id, now);
  }
}

/**
 * Sweep job. Runs periodically and deletes:
 * - suspended streams that have aged past their `max_age_ms`,
 * - ended streams whose retention window has elapsed.
 *
 * Returns the number of rows deleted (useful in tests).
 */
export function sweepDurableStreams(runtime: { sql: DurableStreamRuntime['sql'] }): number {
  const now = Date.now();
  let deleted = 0;
  for (const candidate of Storage.findExpiredSuspended(runtime.sql, now)) {
    Storage.deleteStream(runtime.sql, candidate.identity, candidate.streamId);
    deleted += 1;
  }
  for (const candidate of Storage.findExpiredEnded(runtime.sql, now)) {
    Storage.deleteStream(runtime.sql, candidate.identity, candidate.streamId);
    deleted += 1;
  }
  return deleted;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function runGenerator(
  runtime: DurableStreamRuntime,
  connection: RuntimeConnection,
  scope: ResolvedScope,
  def: DurableStreamRuntimeDef,
  payload: unknown,
  streamId: string,
  identity: string,
  initialCursor: unknown,
  attempt: number,
): Promise<void> {
  const ctx = runtime.buildConnectionContext(connection, scope) as Record<string, unknown>;
  ctx.stream = {
    id: streamId,
    cursor: initialCursor,
    attempt,
    withCursor: (chunk: unknown, cursor: unknown) => makeCursorChunk(chunk, cursor),
  };

  const iterator = def.generator(ctx, payload);
  const activeStream: ActiveStream = {
    id: streamId,
    connectionId: connection.id,
    event: def.event,
    generator: iterator as AsyncGenerator<unknown, void, unknown>,
    nudges: [],
    nudgeValidators: new Map(),
    closed: false,
  };

  runtime.activeStreams.set(streamId, activeStream);
  if (!connection.activeStreamIds) connection.activeStreamIds = new Set();
  connection.activeStreamIds.add(streamId);
  runtime.persistAttachment(connection);

  let seq = 0;
  try {
    while (!activeStream.closed) {
      runtime.setActiveConnectionId(connection.id);
      let result: IteratorResult<unknown>;
      try {
        result = await iterator.next();
      } finally {
        runtime.setActiveConnectionId(undefined);
      }
      if (result.done) break;

      seq += 1;
      const { chunkValue, cursorValue } = unwrapYield(result.value);

      // Buffer + cursor persistence happens BEFORE the wire send so a wire
      // failure cannot leave the durable side ahead of the client view.
      const now = Date.now();
      if (def.kind === 'recorded') {
        Storage.appendChunk(runtime.sql, {
          identity,
          streamId,
          seq,
          messageId: null,
          payload: JSON.stringify(chunkValue ?? null),
          now,
        });
        // Trim oldest chunks if we crossed the cap.
        if (def.maxChunks) {
          const count = Storage.countChunks(runtime.sql, identity, streamId);
          if (count > def.maxChunks) {
            Storage.trimOldestChunks(runtime.sql, identity, streamId, def.maxChunks);
            // Throw into the generator so the dev can catch and react.
            try {
              await iterator.throw(StreamAborted({ reason: 'buffer-full' }));
            } catch (err) {
              rethrowIfConfigError(err);
              throw err;
            }
            break;
          }
        }
        Storage.updateLastSeq(runtime.sql, identity, streamId, seq, now);
      } else if (def.kind === 'resumable' && cursorValue !== undefined) {
        Storage.updateCursor(
          runtime.sql,
          identity,
          streamId,
          JSON.stringify(cursorValue),
          seq,
          now,
        );
      } else {
        // Resumable yield without cursor — still bump last_seq for housekeeping.
        Storage.updateLastSeq(runtime.sql, identity, streamId, seq, now);
      }

      const wirePayload: Record<string, unknown> =
        typeof chunkValue === 'object' && chunkValue !== null && !Array.isArray(chunkValue)
          ? { ...(chunkValue as Record<string, unknown>) }
          : { value: chunkValue };

      // Routing markers (`_streamId`, `_seq`) are added by the pipeline's
      // injectRoutingMarkers. The payload itself is pure user data so the
      // engine's reserved-field check passes.
      runtime.sendThroughPipeline(
        connection,
        {
          namespace: scope.namespace?.name,
          channel: scope.channelName,
          channelScope: scope.channelScope,
          streamId,
          seq,
        },
        def.event,
        wirePayload,
      );
    }

    if (activeStream.closed) {
      // Closed externally (disconnect cancel-but-buffer, or explicit cancel).
      // For an explicit cancel, cancelDurableStream has already deleted the
      // row + chunks. For a disconnect, the row is still 'active'; mark it
      // 'suspended' so resume can pick up where we stopped.
      const row = Storage.readStream(runtime.sql, identity, streamId);
      if (row && row.status === 'active') {
        Storage.markSuspended(runtime.sql, identity, streamId, Date.now());
      }
      return;
    }

    // Generator returned cleanly. Mark ended, fire _streamEnd, schedule sweep
    // via retention. We do not delete immediately — the client may still be
    // listening and might disconnect briefly between the last chunk and a
    // resume call.
    Storage.markEnded(runtime.sql, identity, streamId, Date.now());
    runtime.sendProtocolMessage(connection, '_streamEnd', {
      _streamId: streamId,
      _seq: seq,
    });
  } catch (error) {
    rethrowIfConfigError(error);
    await runtime.handleRuntimeError(connection, error, def.event, { _streamId: streamId });
    // On error, hand control to the engine's runtime-error path. We still
    // mark the row ended so the sweeper reaps it after retention.
    Storage.markEnded(runtime.sql, identity, streamId, Date.now());
  } finally {
    activeStream.closed = true;
    runtime.activeStreams.delete(streamId);
    connection.activeStreamIds?.delete(streamId);
    runtime.persistAttachment(connection);
  }
}

function unwrapYield(value: unknown): { chunkValue: unknown; cursorValue: unknown } {
  if (isCursorChunk(value)) return { chunkValue: value.chunk, cursorValue: value.cursor };
  return { chunkValue: value, cursorValue: undefined };
}

/**
 * Cancel a durable stream — synchronous delete of the row + chunks.
 * Mirrors the plain `cancelStream` but also clears storage.
 */
export async function cancelDurableStream(
  runtime: DurableStreamRuntime,
  connection: RuntimeConnection,
  streamId: string,
): Promise<void> {
  const active = runtime.activeStreams.get(streamId);
  if (active && active.connectionId === connection.id && !active.closed) {
    active.closed = true;
    try {
      await active.generator.return(undefined);
    } catch (error) {
      runtime.logger.warn('[wskit] durable stream cleanup threw on cancel', {
        streamId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      runtime.activeStreams.delete(streamId);
      connection.activeStreamIds?.delete(streamId);
    }
  }
  Storage.deleteStream(runtime.sql, connection.identity ?? connection.id, streamId);
}
