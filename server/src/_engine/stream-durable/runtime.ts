/* oxlint-disable @typescript-eslint/no-explicit-any */

import { rethrowIfConfigError, StreamAborted, StreamIdCollision } from '@wskit/core';
import { validateValue } from '~/_engine/compile/utils.ts';
import {
  assertNoConcurrentStream,
  buildActiveStream,
  installCtxNudges,
  resolveBroadcastTargets,
} from '~/_engine/stream-common/active-stream.ts';
import type * as Protocol from '~/_engine/runtime/protocol.ts';
import type {
  ActiveStream,
  OnDisconnect,
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
    wskit: Record<string, unknown>,
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
    routing?: Protocol.WskitRouting,
  ): Promise<void>;
}

/** Engine-side snapshot of one nudge declaration: wire event + optional validator. */
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
  /** Validator for the saved cursor (resumable streams only). */
  readonly cursor?: unknown;
  /** Disconnect policy — drives whether the generator survives the drop. */
  readonly onDisconnect?: OnDisconnect;
}

/** Build the `__wskit` routing block for a durable-stream frame from a live scope. */
function scopeWskit(scope: ResolvedScope): Record<string, unknown> {
  const wskit: Record<string, unknown> = {};
  if (scope.namespace?.name) wskit.namespace = scope.namespace.name;
  if (scope.channelName) wskit.channel = scope.channelName;
  if (scope.channelScope) wskit.channelScope = scope.channelScope;
  return wskit;
}

/** Build the `__wskit` routing block from a stored stream row. */
function rowWskit(row: Storage.DurableStreamRow): Record<string, unknown> {
  const wskit: Record<string, unknown> = {};
  if (row.namespace) wskit.namespace = row.namespace;
  if (row.channelKey) wskit.channel = row.channelKey;
  if (row.channelScope) wskit.channelScope = row.channelScope;
  return wskit;
}

/** A stream chunk becomes the frame payload; a non-object chunk is wrapped in `{ value }`. */
function chunkToPayload(chunkValue: unknown): Record<string, unknown> {
  return typeof chunkValue === 'object' && chunkValue !== null && !Array.isArray(chunkValue)
    ? { ...(chunkValue as Record<string, unknown>) }
    : { value: chunkValue };
}

/** Read a client-supplied `streamId` from the trigger frame's `__wskit`. */
function readSuppliedStreamId(wskit: Protocol.WskitProtocol | undefined): string | undefined {
  const value = wskit?.streamId;
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
  wskit: Protocol.WskitProtocol | undefined,
): Promise<void> {
  const creatorIdentity = connection.identity ?? connection.id;
  // For broadcast streams the storage row is keyed by a synthetic scope key
  // so every subscriber resolves the same row. The real creator goes into
  // creator_identity for cancel ownership checks.
  const storageIdentity = def.broadcast ? computeBroadcastScopeKey(scope) : creatorIdentity;

  assertNoConcurrentStream(runtime, connection, def.event, def.allowConcurrent);

  const supplied = readSuppliedStreamId(wskit);
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

  runtime.sendProtocolMessage(connection, '__streamOk__', {}, { ...scopeWskit(scope), streamId });

  await runGenerator(
    runtime,
    connection,
    scope,
    def,
    payload,
    streamId,
    storageIdentity,
    null,
    1,
    0,
  );
}

/**
 * Look up the durable-stream row for a `__resumeStream__` frame. Tries the
 * resuming connection's real identity first (single-subscriber streams) and
 * then the broadcast scope key derived from the frame's routing markers
 * (broadcast streams). Returns null when nothing matches.
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

/** Handle a client `__resumeStream__` frame for a suspended or ended durable stream. */
export async function resumeDurableStream(
  runtime: DurableStreamRuntime,
  connection: RuntimeConnection,
  resolveDef: (
    row: Storage.DurableStreamRow,
  ) => { def: DurableStreamRuntimeDef; scope: ResolvedScope } | undefined,
  row: Storage.DurableStreamRow | null,
  streamId: string,
  lastKnownSeq: number,
): Promise<void> {
  if (!row) {
    runtime.sendProtocolMessage(
      connection,
      '__error__',
      { code: StreamAborted.code, detail: { reason: 'not-found' as const } },
      { streamId },
    );
    return;
  }

  const nowAtResume = Date.now();
  if (
    row.status === 'suspended' &&
    row.maxAgeMs != null &&
    row.lastActivityAt + row.maxAgeMs < nowAtResume
  ) {
    Storage.deleteStream(runtime.sql, row.identity, streamId);
    runtime.sendProtocolMessage(
      connection,
      '__error__',
      { code: StreamAborted.code, detail: { reason: 'expired' as const } },
      { ...rowWskit(row), streamId },
    );
    return;
  }
  if (
    row.status === 'ended' &&
    row.endedAt != null &&
    row.retentionAfterEndMs != null &&
    row.endedAt + row.retentionAfterEndMs < nowAtResume
  ) {
    Storage.deleteStream(runtime.sql, row.identity, streamId);
    runtime.sendProtocolMessage(
      connection,
      '__error__',
      { code: StreamAborted.code, detail: { reason: 'not-found' as const } },
      { ...rowWskit(row), streamId },
    );
    return;
  }

  const storageIdentity = row.identity;
  const realIdentityForGuard = connection.identity ?? connection.id;
  if (
    row.broadcast &&
    Storage.isUnsubscribed(runtime.sql, storageIdentity, streamId, realIdentityForGuard)
  ) {
    runtime.sendProtocolMessage(
      connection,
      '__error__',
      { code: StreamAborted.code, detail: { reason: 'unsubscribed' as const } },
      { streamId },
    );
    return;
  }

  const resolved = resolveDef(row);
  if (!resolved) {
    runtime.sendProtocolMessage(
      connection,
      '__error__',
      { code: StreamAborted.code, detail: { reason: 'not-found' as const } },
      { streamId },
    );
    return;
  }
  const { def, scope } = resolved;

  const realIdentity = realIdentityForGuard;
  // Peer-subscriber on a broadcast stream: replay buffered chunks since
  // `lastKnownSeq` and return. Subscribers never re-invoke the generator; only
  // the creator can do that (handled below).
  const isPeerSubscriber =
    row.broadcast && row.creatorIdentity !== null && row.creatorIdentity !== realIdentity;

  // Scope routing for every frame the resume path emits, so late frames look
  // the same as live ones.
  const scopeMarkers = rowWskit(row);

  // Creator-side adopt path for a keep-running stream whose generator is still
  // alive after the owning client dropped. Swap the wire target to the new
  // connection, replay buffered chunks, and return — future yields land on the
  // adopted connection.
  if (!isPeerSubscriber && row.status === 'active') {
    const live = runtime.activeStreams.get(streamId);
    if (live && live.detached) {
      live.connection = connection;
      live.connectionId = connection.id;
      live.detached = false;
      if (!connection.activeStreamIds) connection.activeStreamIds = new Set();
      connection.activeStreamIds.add(streamId);
      runtime.persistAttachment(connection);

      runtime.sendProtocolMessage(connection, '__streamOk__', {}, { ...scopeMarkers, streamId });
      const chunks = Storage.readChunksSince(runtime.sql, storageIdentity, streamId, lastKnownSeq);
      for (const chunk of chunks) {
        runtime.sendProtocolMessage(
          connection,
          def.event,
          chunkToPayload(JSON.parse(chunk.payload)),
          {
            ...scopeMarkers,
            streamId,
            seq: chunk.seq,
            ...(chunk.messageId ? { messageId: chunk.messageId } : {}),
          },
        );
      }
      return;
    }
  }

  // Non-peer resume: a stale in-memory entry may still be parked in an `await`;
  // nudge it to close but don't block. The finally guard in runGenerator stops
  // it from clobbering the new entry when it eventually drains.
  if (!isPeerSubscriber) {
    const existing = runtime.activeStreams.get(streamId);
    if (existing) {
      existing.closed = true;
      try {
        void existing.generator.return(undefined);
      } catch {
        /* drains in its own finally */
      }
    }
  }

  if (row.kind === 'recorded' || isPeerSubscriber) {
    const chunks = Storage.readChunksSince(runtime.sql, storageIdentity, streamId, lastKnownSeq);
    for (const chunk of chunks) {
      runtime.sendProtocolMessage(
        connection,
        def.event,
        chunkToPayload(JSON.parse(chunk.payload)),
        {
          ...scopeMarkers,
          streamId,
          seq: chunk.seq,
          ...(chunk.messageId ? { messageId: chunk.messageId } : {}),
        },
      );
    }
  }

  if (row.status === 'ended') {
    runtime.sendProtocolMessage(
      connection,
      '__streamEnd__',
      {},
      { ...scopeMarkers, streamId, seq: row.lastSeq },
    );
    return;
  }

  // Broadcast peer-subscriber resume: caught up from the buffer; live future
  // chunks arrive via broadcastToConnections. Don't end or restart.
  if (isPeerSubscriber) return;

  if (row.kind === 'recorded') {
    // Recorded streams have no cursor to resume from — the generator runs once
    // end-to-end. The creator's resume after a drop is terminal: replay the
    // buffer, mark the row ended, signal __streamEnd__.
    Storage.markEnded(runtime.sql, storageIdentity, streamId, Date.now());
    runtime.sendProtocolMessage(
      connection,
      '__streamEnd__',
      {},
      { ...scopeMarkers, streamId, seq: row.lastSeq },
    );
    return;
  }

  let cursor: unknown = null;
  if (row.cursor) {
    const raw = JSON.parse(row.cursor);
    try {
      cursor = def.cursor ? validateValue(def.cursor, raw, '__resumeStream__') : raw;
    } catch {
      runtime.sendProtocolMessage(
        connection,
        '__error__',
        { code: StreamAborted.code, detail: { reason: 'cursor-invalid' as const } },
        { ...scopeMarkers, streamId },
      );
      return;
    }
  }
  const payload = JSON.parse(row.payload);
  runtime.sendProtocolMessage(connection, '__streamOk__', {}, { ...scopeMarkers, streamId });

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
    row.lastSeq,
  );
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
  startSeq: number,
): Promise<void> {
  const ctx = runtime.buildConnectionContext(connection, scope) as Record<PropertyKey, unknown>;
  ctx.stream = {
    id: streamId,
    cursor: initialCursor,
    attempt,
    withCursor: (chunk: unknown, cursor: unknown) => makeCursorChunk(chunk, cursor),
  };
  installCtxNudges(ctx);

  const iterator = def.generator(ctx, payload) as AsyncGenerator<unknown, void, unknown>;
  const { active: activeStream, nudgeBuffer } = buildActiveStream({
    streamId,
    event: def.event,
    connection,
    generator: iterator,
    nudges: def.nudges ?? [],
    onDisconnect: def.onDisconnect,
  });

  runtime.activeStreams.set(streamId, activeStream);
  if (!connection.activeStreamIds) connection.activeStreamIds = new Set();
  connection.activeStreamIds.add(streamId);
  runtime.persistAttachment(connection);

  const hasNudges = (def.nudges?.length ?? 0) > 0;
  let nextInput: unknown = hasNudges ? [] : undefined;

  let seq = startSeq;
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
      // Broadcast streams (both kinds) record every chunk so late joiners and
      // reconnecting subscribers can catch up from the buffer.
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

      const wirePayload = chunkToPayload(chunkValue);

      if (def.broadcast) {
        const targets = resolveBroadcastTargets({
          runtime,
          excludeConnectionId: connection.id,
          scope,
          extraFilter: (candidate) =>
            !Storage.isUnsubscribed(
              runtime.sql,
              identity,
              streamId,
              candidate.identity ?? candidate.id,
            ),
        });
        // The outgoing pipeline puts streamId + seq into __wskit from the
        // routing markers — pass the bare chunk as the payload.
        for (const target of targets) {
          runtime.sendThroughPipeline(
            target,
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
      }

      // For keep-running streams, `activeStream.connection` may have been
      // swapped to a fresh connection on resume; for detached streams with no
      // client yet attached, skip the creator-side wire send (the chunk is
      // already in the buffer for a later resume).
      const wireTarget = activeStream.connection ?? connection;
      if (!activeStream.detached) {
        runtime.sendThroughPipeline(
          wireTarget,
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

      if (hasNudges) {
        nextInput = [...nudgeBuffer];
        nudgeBuffer.length = 0;
      }
    }

    if (activeStream.closed) {
      // Disconnect with cancel-but-buffer. The cancel path already deleted the
      // row; only suspend if it's still active.
      const row = Storage.readStream(runtime.sql, identity, streamId);
      if (row && row.status === 'active') {
        Storage.markSuspended(runtime.sql, identity, streamId, Date.now());
      }
      return;
    }

    Storage.markEnded(runtime.sql, identity, streamId, Date.now());
    runtime.sendProtocolMessage(
      connection,
      '__streamEnd__',
      {},
      { ...scopeWskit(scope), streamId, seq },
    );
    if (def.broadcast) {
      // Tell every peer subscriber the source generator finished. They'd
      // otherwise only learn on their next resume attempt.
      const peerTargets = resolveBroadcastTargets({
        runtime,
        excludeConnectionId: connection.id,
        scope,
        extraFilter: (candidate) =>
          !Storage.isUnsubscribed(
            runtime.sql,
            identity,
            streamId,
            candidate.identity ?? candidate.id,
          ),
      });
      const endWskit = { ...scopeWskit(scope), streamId, seq };
      for (const target of peerTargets) {
        runtime.sendProtocolMessage(target, '__streamEnd__', {}, endWskit);
      }
    }
  } catch (error) {
    rethrowIfConfigError(error);
    await runtime.handleRuntimeError(connection, error, def.event, { streamId });
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
 * Cancel a durable stream from a client `__streamCancel__` frame.
 *
 * - Single-subscriber stream: stop the generator, delete the row + chunks.
 * - Broadcast stream from the creator identity: same — kills it for everyone.
 * - Broadcast stream from a non-creator identity: add the caller's identity to
 *   the per-stream unsubscribed list so the fanout skips them. The source keeps
 *   running for everyone else.
 */
export async function cancelDurableStream(
  runtime: DurableStreamRuntime,
  connection: RuntimeConnection,
  streamId: string,
  cancelScope: ResolvedScope,
): Promise<void> {
  const realIdentity = connection.identity ?? connection.id;
  const row = findResumeRow(runtime, connection, cancelScope, streamId);
  if (!row) return;

  if (row.broadcast && row.creatorIdentity && row.creatorIdentity !== realIdentity) {
    // Non-creator cancel of a broadcast stream — drop this identity from future
    // fanout; the source keeps running for everyone else.
    Storage.markUnsubscribed(runtime.sql, row.identity, streamId, realIdentity, Date.now());
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
