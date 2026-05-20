/* oxlint-disable @typescript-eslint/no-explicit-any */

import {
  rethrowIfConfigError,
  StreamAborted,
  StreamAlreadyActive,
  StreamIdCollision,
} from '@wskit/core';
import * as ChannelPrimitive from '~/channel/runtime.ts';
import type {
  ActiveStream,
  ResolvedScope,
  RoutingTarget,
  RuntimeConnection,
} from '~/_engine/runtime/types.ts';
import { isCursorChunk, makeCursorChunk } from './cursor.ts';
import * as Storage from './storage.ts';
import { computeBroadcastScopeKey } from './types.ts';
import type { DurableStreamKind } from './types.ts';

/** Minimal slice of the engine the durable runtime needs to do its job. */
export interface DurableStreamRuntime {
  activeStreams: Map<string, ActiveStream>;
  connections: ReadonlyMap<string, RuntimeConnection>;
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
  broadcastToConnections(
    connections: readonly RuntimeConnection[],
    event: string,
    payload: unknown,
    options?: { namespace?: string; channel?: string; channelScope?: string | null },
    excludeConnectionId?: string,
  ): void;
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

/** One declared nudge on a durable stream — wire event name + payload validator. */
export interface DurableNudge {
  readonly event: string;
  readonly validator?: unknown;
}

/** Snapshot of one durable stream definition relevant to the runtime. */
export interface DurableStreamRuntimeDef {
  readonly event: string;
  readonly kind: DurableStreamKind;
  readonly generator: (ctx: any, payload: any) => AsyncGenerator<unknown, void, unknown>;
  readonly allowConcurrent: boolean;
  readonly broadcast?: boolean;
  readonly nudges?: readonly DurableNudge[];
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
  _connection: RuntimeConnection,
  streamId: string,
  storageIdentity: string,
): void {
  if (runtime.activeStreams.has(streamId)) throw StreamIdCollision();
  // Cross-socket collision: same storage identity, same id, different connection.
  const row = Storage.readStream(runtime.sql, storageIdentity, streamId);
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
  const creatorIdentity = connection.identity ?? connection.id;
  // For broadcast streams the storage row is keyed by a synthetic scope key
  // so every subscriber resolves the same row. The real creator goes into
  // creator_identity for cancel ownership checks.
  const storageIdentity = def.broadcast ? computeBroadcastScopeKey(scope) : creatorIdentity;

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
  ensureUniqueStreamId(runtime, connection, streamId, storageIdentity);

  const now = Date.now();
  Storage.insertStream(runtime.sql, {
    identity: storageIdentity,
    streamId,
    event: def.event,
    payload: JSON.stringify(payload ?? null),
    kind: def.kind,
    now,
    namespace: scope.namespace?.name ?? null,
    channelKey: scope.channelName ?? null,
    channelScope: scope.channelScope ?? null,
    broadcast: def.broadcast ?? false,
    creatorIdentity,
    maxChunks: def.maxChunks,
    maxAgeMs: def.maxAgeMs,
    retentionAfterEndMs: def.retentionAfterEndMs,
  });

  runtime.sendProtocolMessage(connection, '_streamOk', { _streamId: streamId });

  await runGenerator(runtime, connection, scope, def, payload, streamId, storageIdentity, null, 1);
}

/**
 * Look up the durable-stream row for a `_resumeStream` frame. Tries the
 * resuming connection's real identity first (single-subscriber streams)
 * and then the broadcast scope key derived from the frame's routing
 * markers (broadcast streams). Returns null when nothing matches.
 */
export function findResumeRow(
  runtime: DurableStreamRuntime,
  connection: RuntimeConnection,
  resumeScope: ResolvedScope,
  streamId: string,
): Storage.DurableStreamRow | null {
  const realIdentity = connection.identity ?? connection.id;
  const single = Storage.readStream(runtime.sql, realIdentity, streamId);
  if (single) return single;
  const scopeKey = computeBroadcastScopeKey(resumeScope);
  return Storage.readStream(runtime.sql, scopeKey, streamId);
}

/** Handle a client `_resumeStream` frame for a suspended or ended durable stream. */
export async function resumeDurableStream(
  runtime: DurableStreamRuntime,
  connection: RuntimeConnection,
  resolveDef: (
    row: Storage.DurableStreamRow,
  ) => { def: DurableStreamRuntimeDef; scope: ResolvedScope } | undefined,
  row: Storage.DurableStreamRow | null,
  streamId: string,
  since: number,
): Promise<void> {
  if (!row) {
    runtime.sendProtocolMessage(connection, '_error', {
      code: StreamAborted.code,
      detail: { reason: 'not-found' as const },
      _streamId: streamId,
    });
    return;
  }

  const storageIdentity = row.identity;

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

  const resolved = resolveDef(row);
  if (!resolved) {
    runtime.sendProtocolMessage(connection, '_error', {
      code: StreamAborted.code,
      detail: { reason: 'not-found' as const },
      _streamId: streamId,
    });
    return;
  }
  const { def, scope } = resolved;

  const realIdentity = connection.identity ?? connection.id;
  // Peer-subscriber on a broadcast stream: replay buffered chunks since
  // `since` and return. Subscribers never re-invoke the generator; only the
  // creator can do that (handled below).
  const isPeerSubscriber =
    row.broadcast && row.creatorIdentity !== null && row.creatorIdentity !== realIdentity;

  if (row.kind === 'recorded' || isPeerSubscriber) {
    const chunks = Storage.readChunksSince(runtime.sql, storageIdentity, streamId, since);
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

  // Broadcast peer-subscriber resume: caught up from the buffer; live future
  // chunks arrive via broadcastToConnections. Don't end or restart.
  if (isPeerSubscriber) return;

  if (row.kind === 'recorded') {
    // Single-subscriber recorded: caught up; mark ended.
    if (row.broadcast) return;
    Storage.markEnded(runtime.sql, storageIdentity, streamId, Date.now());
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
    storageIdentity,
    streamId,
  );

  await runGenerator(
    runtime,
    connection,
    scope,
    def,
    payload,
    streamId,
    storageIdentity,
    cursor,
    2,
  );
}

/**
 * Mark every active durable stream owned by `connection` as suspended.
 *
 * Broadcast streams use a synthetic scope-key identity rather than the
 * connection's identity, so we read the row to find the right key. A
 * broadcast stream stays running on the source connection; only single-
 * subscriber rows get suspended here.
 */
export function markStreamsSuspendedForConnection(
  runtime: { sql: DurableStreamRuntime['sql']; activeStreams: Map<string, ActiveStream> },
  connection: RuntimeConnection,
): void {
  const realIdentity = connection.identity ?? connection.id;
  const now = Date.now();
  for (const active of runtime.activeStreams.values()) {
    if (active.connectionId !== connection.id) continue;
    // Broadcast streams: try both keys — broadcast scope keys are synthetic
    // (`__bcast:*__`) and look nothing like a real identity.
    const single = Storage.readStream(runtime.sql, realIdentity, active.id);
    if (single) {
      Storage.markSuspended(runtime.sql, realIdentity, active.id, now);
    }
    // For broadcasts, leaving the row 'active' is fine — the row's identity
    // is the scope key, no single-connection suspend applies. Phase 5 will
    // refine cancel ownership for broadcasts.
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
  // Mirrors plain stream's ctx.nudges() helper: dev passes whatever value the
  // generator's `yield` resolved to and gets the buffered nudge array back.
  ctx.nudges = (value: unknown) => (Array.isArray(value) ? value : []);

  const iterator = def.generator(ctx, payload);
  const nudgeValidators = new Map<string, unknown>();
  for (const nudge of def.nudges ?? []) {
    nudgeValidators.set(nudge.event, nudge.validator);
  }
  const nudgeBuffer: { event: string; payload: unknown }[] = [];
  const activeStream: ActiveStream = {
    id: streamId,
    connectionId: connection.id,
    event: def.event,
    generator: iterator as AsyncGenerator<unknown, void, unknown>,
    nudges: nudgeBuffer,
    nudgeValidators,
    closed: false,
  };

  runtime.activeStreams.set(streamId, activeStream);
  if (!connection.activeStreamIds) connection.activeStreamIds = new Set();
  connection.activeStreamIds.add(streamId);
  runtime.persistAttachment(connection);

  const hasNudges = (def.nudges?.length ?? 0) > 0;
  let nextInput: unknown = hasNudges ? [] : undefined;

  let seq = 0;
  try {
    while (!activeStream.closed) {
      runtime.setActiveConnectionId(connection.id);
      let result: IteratorResult<unknown>;
      try {
        result = await iterator.next(nextInput);
      } finally {
        runtime.setActiveConnectionId(undefined);
      }
      if (result.done) break;

      seq += 1;
      const { chunkValue, cursorValue } = unwrapYield(result.value);

      // Persist before wire so a send failure can't leave durable state ahead.
      const now = Date.now();
      // Broadcast streams (both kinds) record every chunk so late joiners
      // and reconnecting subscribers can catch up from the buffer.
      const recordsChunks = def.kind === 'recorded' || def.broadcast === true;
      if (recordsChunks) {
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
      }

      if (def.kind === 'resumable' && cursorValue !== undefined) {
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

      if (def.broadcast) {
        // Fan out to every other connection in scope. Channel-scoped streams
        // go to channel members only; namespace and top-level go to every
        // connection. The creator gets the chunk via sendThroughPipeline
        // below, so excludeSelf is implicit.
        const targets: RuntimeConnection[] = [];
        for (const candidate of runtime.connections.values()) {
          if (candidate.id === connection.id) continue;
          if (scope.channelName) {
            if (
              ChannelPrimitive.hasChannelMembership(
                candidate,
                scope.channelName,
                scope.channelScope ?? null,
              )
            ) {
              targets.push(candidate);
            }
          } else {
            targets.push(candidate);
          }
        }
        runtime.broadcastToConnections(
          targets,
          def.event,
          { ...wirePayload, _streamId: streamId, _seq: seq },
          {
            namespace: scope.namespace?.name,
            channel: scope.channelName,
            channelScope: scope.channelScope,
          },
          connection.id,
        );
      }

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

      // Drain buffered nudges into the next iterator.next() input and clear
      // the queue. Mirrors plain stream's loop tail so dev code calling
      // `ctx.nudges(value)` sees the same shape on every yield.
      if (hasNudges) {
        nextInput = [...nudgeBuffer];
        nudgeBuffer.length = 0;
      }
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

/**
 * Cancel a durable stream from a client `_streamCancel` frame.
 *
 * - Single-subscriber stream: stop the generator, delete the row + chunks.
 * - Broadcast stream from the creator identity: same — kills it for everyone.
 * - Broadcast stream from a non-creator: silently no-op for v1; the resuming
 *   client just stops listening. Phase 5 will turn this into a per-subscriber
 *   unsubscribe with proper subscriber tracking.
 */
export async function cancelDurableStream(
  runtime: DurableStreamRuntime,
  connection: RuntimeConnection,
  streamId: string,
  cancelScope: ResolvedScope,
): Promise<void> {
  const realIdentity = connection.identity ?? connection.id;
  // Look up the row — try real identity first, then the broadcast scope key.
  const row = findResumeRow(runtime, connection, cancelScope, streamId);
  if (!row) return;

  if (row.broadcast && row.creatorIdentity && row.creatorIdentity !== realIdentity) {
    // Non-creator client cancel of a broadcast stream — phase 5 will detach
    // the subscriber; for now we leave the source running.
    return;
  }

  const active = runtime.activeStreams.get(streamId);
  if (active && !active.closed) {
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
  Storage.deleteStream(runtime.sql, row.identity, streamId);
}
