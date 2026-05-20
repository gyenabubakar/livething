/* oxlint-disable @typescript-eslint/no-explicit-any */
/**
 * Runtime for durable streams (resumable + recorded). Top-level only in v1;
 * no broadcast, no nudges.
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
import { isCursorChunk, makeCursorChunk } from './cursor.ts';
import * as Storage from './storage.ts';
import type { DurableStreamKind } from './types.ts';

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
  // Cross-socket collision: same identity, same id, different connection.
  const row = Storage.readStream(runtime.sql, connection.identity ?? connection.id, streamId);
  if (row && row.status === 'active') throw StreamIdCollision();
}

/** Start a fresh durable stream from a client trigger frame. */
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

/** Handle a client `_resume` frame for a suspended or ended durable stream. */
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

  // A stale in-memory entry may still be parked in an `await`; nudge it to
  // close but don't block. The finally guard below stops it from clobbering
  // the new entry when it eventually drains.
  const existing = runtime.activeStreams.get(streamId);
  if (existing) {
    existing.closed = true;
    try {
      void existing.generator.return(undefined);
    } catch {
      /* drains in its own finally */
    }
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

  if (row.kind === 'recorded') {
    Storage.markEnded(runtime.sql, identity, streamId, Date.now());
    runtime.sendProtocolMessage(connection, '_streamEnd', {
      _streamId: streamId,
      _seq: row.lastSeq,
    });
    return;
  }

  const cursor = row.cursor ? JSON.parse(row.cursor) : null;
  const payload = JSON.parse(row.payload);
  runtime.sendProtocolMessage(connection, '_streamOk', { _streamId: streamId });

  runtime.sql.exec(
    "UPDATE _wskit_streams SET status = 'active', last_activity_at = ? WHERE identity = ? AND stream_id = ?",
    Date.now(),
    identity,
    streamId,
  );

  await runGenerator(runtime, connection, scope, def, payload, streamId, identity, cursor, 2);
}

/** Mark every active durable stream owned by `connection` as suspended. */
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

/** Delete suspended rows past `maxAgeMs` and ended rows past `retentionAfterEndMs`. */
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

      // Persist before wire so a send failure can't leave durable state ahead.
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
        if (def.maxChunks) {
          const count = Storage.countChunks(runtime.sql, identity, streamId);
          if (count > def.maxChunks) {
            Storage.trimOldestChunks(runtime.sql, identity, streamId, def.maxChunks);
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
        Storage.updateLastSeq(runtime.sql, identity, streamId, seq, now);
      }

      const wirePayload: Record<string, unknown> =
        typeof chunkValue === 'object' && chunkValue !== null && !Array.isArray(chunkValue)
          ? { ...(chunkValue as Record<string, unknown>) }
          : { value: chunkValue };

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
      // Disconnect with cancel-but-buffer. Cancel path already deleted the
      // row; only suspend if it's still active.
      const row = Storage.readStream(runtime.sql, identity, streamId);
      if (row && row.status === 'active') {
        Storage.markSuspended(runtime.sql, identity, streamId, Date.now());
      }
      return;
    }

    Storage.markEnded(runtime.sql, identity, streamId, Date.now());
    runtime.sendProtocolMessage(connection, '_streamEnd', {
      _streamId: streamId,
      _seq: seq,
    });
  } catch (error) {
    rethrowIfConfigError(error);
    await runtime.handleRuntimeError(connection, error, def.event, { _streamId: streamId });
    Storage.markEnded(runtime.sql, identity, streamId, Date.now());
  } finally {
    activeStream.closed = true;
    // Don't clobber a slot taken over by a resume run.
    if (runtime.activeStreams.get(streamId) === activeStream) {
      runtime.activeStreams.delete(streamId);
    }
    connection.activeStreamIds?.delete(streamId);
    runtime.persistAttachment(connection);
  }
}

function unwrapYield(value: unknown): { chunkValue: unknown; cursorValue: unknown } {
  if (isCursorChunk(value)) return { chunkValue: value.chunk, cursorValue: value.cursor };
  return { chunkValue: value, cursorValue: undefined };
}

/** Cancel a durable stream: stop the generator and delete the row + chunks. */
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
