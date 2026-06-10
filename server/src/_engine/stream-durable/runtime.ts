/* oxlint-disable @typescript-eslint/no-explicit-any */

import { rethrowIfConfigError, StreamAborted, StreamIdCollision } from '@wskit/core';
import { withConnectionContext } from '~/_engine/async-context.ts';
import { validateValue } from '~/_engine/compile/utils.ts';
import { forEachIsolated } from '~/_engine/runtime/isolation.ts';
import { serializeJsonOrThrow } from '~/_engine/runtime/json-guard.ts';
import { storageIdentityOf } from '~/_engine/runtime/types.ts';
import {
  assertNoConcurrentStream,
  buildActiveStream,
  installCtxNudges,
  resolveBroadcastTargets,
} from '~/_engine/stream-common/active-stream.ts';
import { normalizeRuntimeError } from '~/errors/runtime.ts';
import type { EngineAsyncContext } from '~/_engine/async-context.ts';
import type * as Protocol from '~/_engine/runtime/protocol.ts';
import type {
  ActiveStream,
  OnDisconnect,
  ResolvedScope,
  RoutingTarget,
  RuntimeConnection,
} from '~/_engine/runtime/types.ts';
import type { Logger } from '~/context.ts';
import { isCursorChunk, makeCursorChunk } from './cursor.ts';
import * as Storage from './storage.ts';
import { computeBroadcastScopeKey } from './types.ts';
import type { DurableStreamKind } from './types.ts';

/** Minimal slice of the engine the durable runtime needs to do its job. */
export interface DurableStreamRuntime {
  activeStreams: Map<string, ActiveStream>;

  connections: ReadonlyMap<string, RuntimeConnection>;

  generateId(prefix?: string): string;

  logger: Pick<Logger, 'warn'>;

  errorHooks: readonly ((ctx: unknown, error: unknown, event?: string) => void | Promise<void>)[];

  declaredErrorCodes: ReadonlySet<string>;

  buildConnectionContext(
    connection: RuntimeConnection,
    scope?: ResolvedScope,
  ): Record<PropertyKey, unknown>;

  sendProtocolMessage(
    connection: RuntimeConnection,
    opts: { event: string; payload: Record<string, unknown>; wskit: Record<string, unknown> },
  ): void;

  sendThroughPipeline(
    connection: RuntimeConnection,
    opts: { routing: RoutingTarget | undefined; event: string; payload: unknown },
  ): boolean;

  asyncContext: EngineAsyncContext;

  persistAttachment(connection: RuntimeConnection): void;

  /** SQLite handle. Undefined when storage was not configured (engine asserts). */
  sql: {
    exec(query: string, ...params: unknown[]): { toArray(): Record<string, unknown>[] };
  };

  handleRuntimeError(
    connection: RuntimeConnection,
    opts: { error: unknown; event?: string; routing?: Protocol.WSKitRouting },
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
function buildScopeRouting(scope: ResolvedScope): Partial<Protocol.WSKitProtocol> {
  const wskit: Partial<Protocol.WSKitProtocol> = {};
  if (scope.namespace?.name) wskit.namespace = scope.namespace.name;
  if (scope.channelName) wskit.channel = scope.channelName;
  if (scope.channelScope) wskit.channelScope = scope.channelScope;
  return wskit;
}

/** Build the `__wskit` routing block from a stored stream row. */
function buildRowRouting(row: Storage.DurableStreamRow): Partial<Protocol.WSKitProtocol> {
  const wskit: Partial<Protocol.WSKitProtocol> = {};

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

/**
 * Send buffered chunks to a connection using pre-built wire frames.
 *
 * Each chunk's payload is already a valid JSON string in the database (it was
 * `JSON.stringify`-ed on write), so we splice it directly into the frame
 * string rather than parse → spread → re-stringify per chunk. The constant
 * parts of `__wskit` (scope markers + streamId) are also serialized once
 * before the loop, then only the per-chunk `seq` (a plain number) and the
 * optional `messageId` are appended.
 */
interface SendChunkFramesOpts {
  eventName: string;

  chunks: Storage.DurableStreamChunkRow[];

  scopeMarkers: Record<string, unknown>;

  streamId: string;
}

function sendChunkFrames(connection: RuntimeConnection, opts: SendChunkFramesOpts): void {
  const { eventName, chunks, scopeMarkers, streamId } = opts;
  if (chunks.length === 0) return;

  const eventJson = JSON.stringify(eventName);
  // Serialize the constant part of __wskit (scope fields + streamId), strip the
  // closing "}" so we can append ,"seq":N} per chunk without a full re-serialize.
  const wskitPrefix =
    JSON.stringify({ ...scopeMarkers, streamId, streamKind: 'persistent' }).slice(0, -1) +
    ',"seq":';

  for (const chunk of chunks) {
    const wire =
      chunk.messageId !== null
        ? `{"event":${eventJson},"payload":${chunk.payload},"__wskit":${wskitPrefix}${chunk.seq},"messageId":${JSON.stringify(chunk.messageId)}}}`
        : `{"event":${eventJson},"payload":${chunk.payload},"__wskit":${wskitPrefix}${chunk.seq}}}`;

    connection.descriptor.send(wire);
  }
}

function ensureUniqueStreamId(
  runtime: DurableStreamRuntime,
  opts: { streamId: string; storageIdentity: string },
): void {
  const { streamId, storageIdentity } = opts;
  if (runtime.activeStreams.has(streamId)) throw StreamIdCollision();

  // Same stream id already active under this storage identity on another socket.
  const row = Storage.readStream(runtime.sql, storageIdentity, streamId);

  if (row && row.status === 'active') throw StreamIdCollision();
}

export interface RunDurableStreamOptions {
  scope: ResolvedScope;
  def: DurableStreamRuntimeDef;
  payload: unknown;
  wskit: Protocol.WSKitProtocol | undefined;
}

/** Start a fresh durable stream from a client trigger frame. */
export async function runDurableStream(
  runtime: DurableStreamRuntime,
  connection: RuntimeConnection,
  opts: RunDurableStreamOptions,
): Promise<void> {
  const { scope, def, payload, wskit } = opts;
  const creatorIdentity = storageIdentityOf(connection);

  // Broadcast streams key the row by scope so every subscriber finds the same row.
  const storageIdentity = def.broadcast ? computeBroadcastScopeKey(scope) : creatorIdentity;

  assertNoConcurrentStream(runtime, connection, {
    event: def.event,
    allowConcurrent: def.allowConcurrent,
  });

  // The wire schema already bounds and non-empties `streamId` (`StreamIdString`),
  // so its presence is the only thing left to check.
  const streamId = wskit?.streamId ?? runtime.generateId('dstream');
  ensureUniqueStreamId(runtime, { streamId, storageIdentity });

  const now = Date.now();
  Storage.insertStream(runtime.sql, {
    identity: storageIdentity,
    streamId,
    event: def.event,
    payload: serializeJsonOrThrow(
      payload ?? null,
      `Durable stream trigger payload for "${def.event}"`,
    ),
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

  // Seed everyone already in the scope; a late joiner gets its row on resume.

  if (def.broadcast) {
    for (const member of resolveBroadcastTargets({
      runtime,
      excludeConnectionId: connection.id,
      scope,
    })) {
      Storage.seedSubscriber(runtime.sql, {
        storageIdentity,
        streamId,
        subscriberIdentity: storageIdentityOf(member),
      });
    }
  }

  runtime.sendProtocolMessage(connection, {
    event: '__streamOk__',
    payload: {},
    wskit: { ...buildScopeRouting(scope), streamId, streamKind: 'persistent' },
  });

  await runGenerator(runtime, connection, {
    scope,
    def,
    payload,
    streamId,
    identity: storageIdentity,
    initialCursor: null,
    attempt: 1,
    startSeq: 0,
  });
}

/**
 * Look up the durable-stream row for a `__resumeStream__` frame. Tries the
 * connection's own identity first, then the broadcast scope key. Returns null
 * when nothing matches.
 */
export function findResumeRow(
  runtime: DurableStreamRuntime,
  connection: RuntimeConnection,
  opts: { resumeScope: ResolvedScope; streamId: string },
): Storage.DurableStreamRow | null {
  const { resumeScope, streamId } = opts;

  const realIdentity = storageIdentityOf(connection);

  const single = Storage.readStream(runtime.sql, realIdentity, streamId);
  if (single) return single;

  const scopeKey = computeBroadcastScopeKey(resumeScope);

  return Storage.readStream(runtime.sql, scopeKey, streamId);
}

export interface ResumeDurableStreamOptions {
  resolveDef: (
    row: Storage.DurableStreamRow,
  ) => { def: DurableStreamRuntimeDef; scope: ResolvedScope } | undefined;
  row: Storage.DurableStreamRow | null;
  streamId: string;
  lastKnownSeq: number;
}

/** Handle a client `__resumeStream__` frame for a suspended or ended durable stream. */
export async function resumeDurableStream(
  runtime: DurableStreamRuntime,
  connection: RuntimeConnection,
  opts: ResumeDurableStreamOptions,
): Promise<void> {
  const { resolveDef, row, streamId, lastKnownSeq } = opts;
  if (!row) {
    runtime.sendProtocolMessage(connection, {
      event: '__error__',
      payload: { code: StreamAborted.code, detail: { reason: 'not-found' as const } },
      wskit: { streamId },
    });
    return;
  }

  const nowAtResume = Date.now();
  if (
    row.status === 'suspended' &&
    row.maxAgeMs != null &&
    row.lastActivityAt + row.maxAgeMs < nowAtResume
  ) {
    Storage.deleteStream(runtime.sql, row.identity, streamId);
    runtime.sendProtocolMessage(connection, {
      event: '__error__',
      payload: { code: StreamAborted.code, detail: { reason: 'expired' as const } },
      wskit: { ...buildRowRouting(row), streamId },
    });
    return;
  }

  if (
    row.status === 'ended' &&
    row.endedAt != null &&
    row.retentionAfterEndMs != null &&
    row.endedAt + row.retentionAfterEndMs < nowAtResume
  ) {
    Storage.deleteStream(runtime.sql, row.identity, streamId);
    runtime.sendProtocolMessage(connection, {
      event: '__error__',
      payload: { code: StreamAborted.code, detail: { reason: 'not-found' as const } },
      wskit: { ...buildRowRouting(row), streamId },
    });
    return;
  }

  const storageIdentity = row.identity;
  const realIdentityForGuard = storageIdentityOf(connection);
  if (
    row.broadcast &&
    Storage.isUnsubscribed(runtime.sql, {
      storageIdentity,
      streamId,
      subscriberIdentity: realIdentityForGuard,
    })
  ) {
    runtime.sendProtocolMessage(connection, {
      event: '__error__',
      payload: { code: StreamAborted.code, detail: { reason: 'unsubscribed' as const } },
      wskit: { streamId },
    });
    return;
  }

  const resolved = resolveDef(row);
  if (!resolved) {
    runtime.sendProtocolMessage(connection, {
      event: '__error__',
      payload: { code: StreamAborted.code, detail: { reason: 'not-found' as const } },
      wskit: { streamId },
    });
    return;
  }
  const { def, scope } = resolved;

  const realIdentity = realIdentityForGuard;
  // A subscriber (not the creator) on a broadcast stream — never re-runs the generator.
  const isPeerSubscriber =
    row.broadcast && row.creatorIdentity !== null && row.creatorIdentity !== realIdentity;

  const scopeMarkers = buildRowRouting(row);

  // Creator reconnects to a keep-running stream still alive after the drop:
  // point it at the new connection and replay buffered chunks.
  if (!isPeerSubscriber && row.status === 'active') {
    const live = runtime.activeStreams.get(streamId);
    if (live && live.detached) {
      live.connection = connection;
      live.connectionId = connection.id;
      live.detached = false;

      if (!connection.activeStreamIds) connection.activeStreamIds = new Set();

      connection.activeStreamIds.add(streamId);
      runtime.persistAttachment(connection);

      runtime.sendProtocolMessage(connection, {
        event: '__streamOk__',
        payload: {},
        wskit: { ...scopeMarkers, streamId, streamKind: 'persistent' },
      });

      const chunks = Storage.readChunksSince(runtime.sql, {
        identity: storageIdentity,
        streamId,
        since: lastKnownSeq,
      });

      sendChunkFrames(connection, { eventName: def.event, chunks, scopeMarkers, streamId });

      return;
    }
  }

  // Close any stale in-memory entry for this stream, but don't wait on it.
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
    const chunks = Storage.readChunksSince(runtime.sql, {
      identity: storageIdentity,
      streamId,
      since: lastKnownSeq,
    });

    sendChunkFrames(connection, { eventName: def.event, chunks, scopeMarkers, streamId });
    if (isPeerSubscriber) {
      const caughtUpSeq = chunks.length > 0 ? chunks[chunks.length - 1]!.seq : lastKnownSeq;

      Storage.setCaughtUpSeq(runtime.sql, {
        storageIdentity,
        streamId,
        subscriberIdentity: realIdentity,
        caughtUpSeq,
      });
    }
  }

  if (row.status === 'ended') {
    runtime.sendProtocolMessage(connection, {
      event: '__streamEnd__',
      payload: {},
      wskit: { ...scopeMarkers, streamId, seq: row.lastSeq },
    });
    return;
  }

  // Subscriber caught up from the buffer; future chunks come via the broadcast.
  if (isPeerSubscriber) return;

  if (row.kind === 'recorded') {
    // Recorded streams have no cursor — they can't resume, so end the stream.
    Storage.markEnded(runtime.sql, { identity: storageIdentity, streamId, now: Date.now() });

    runtime.sendProtocolMessage(connection, {
      event: '__streamEnd__',
      payload: {},
      wskit: { ...scopeMarkers, streamId, seq: row.lastSeq },
    });
    return;
  }

  // go back to where the client actually was. It tells us the highest seq it
  // got (lastKnownSeq); we start the generator again from the cursor saved at
  // that point, so any rows it missed when the connection dropped get sent
  // again (the client drops repeats by seq). Without this, resume starts from
  // the server's latest cursor and quietly skips a row that was still on its way.
  let startSeq = row.lastSeq;
  let cursorRaw = row.cursor;
  if (lastKnownSeq < row.lastSeq) {
    const anchor = Storage.readCursorAt(runtime.sql, {
      identity: storageIdentity,
      streamId,
      seq: lastKnownSeq,
    });
    startSeq = anchor?.seq ?? 0;
    cursorRaw = anchor?.cursor ?? null;
  }

  let cursor: unknown = null;
  if (cursorRaw) {
    const raw = JSON.parse(cursorRaw);
    try {
      cursor = def.cursor ? validateValue(def.cursor, raw, '__resumeStream__') : raw;
    } catch {
      runtime.sendProtocolMessage(connection, {
        event: '__error__',
        payload: { code: StreamAborted.code, detail: { reason: 'cursor-invalid' as const } },
        wskit: { ...scopeMarkers, streamId },
      });
      return;
    }
  }
  const payload = JSON.parse(row.payload);
  runtime.sendProtocolMessage(connection, {
    event: '__streamOk__',
    payload: {},
    wskit: { ...scopeMarkers, streamId, streamKind: 'persistent' },
  });

  runtime.sql.exec(
    "UPDATE __wskit_streams SET status = 'active', last_activity_at = ? WHERE identity = ? AND stream_id = ?",
    Date.now(),
    storageIdentity,
    streamId,
  );

  await runGenerator(runtime, connection, {
    scope,
    def,
    payload,
    streamId,
    identity: storageIdentity,
    initialCursor: cursor,
    attempt: 2,
    startSeq,
  });
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

interface RunGeneratorOptions {
  scope: ResolvedScope;
  def: DurableStreamRuntimeDef;
  payload: unknown;
  streamId: string;
  identity: string;
  initialCursor: unknown;
  attempt: number;
  startSeq: number;
}

async function runGenerator(
  runtime: DurableStreamRuntime,
  connection: RuntimeConnection,
  opts: RunGeneratorOptions,
): Promise<void> {
  const { scope, def, payload, streamId, identity, initialCursor, attempt, startSeq } = opts;
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
      // Advance the generator inside the connection's async context so plugin
      // APIs it calls (e.g. hooks.getState()) resolve to the stream owner.
      const result = await withConnectionContext(runtime.asyncContext, connection.id, () =>
        iterator.next(nextInput),
      );
      if (result.done) break;

      // Connection closed mid-advance: dropping this chunk keeps a resumable
      // cursor from moving past a row the client never received.
      if (activeStream.closed && def.kind === 'resumable') break;

      seq += 1;
      const { chunkValue, cursorValue } = unwrapYield(result.value);

      // Persist before wire so a send failure can't leave durable state ahead.
      const now = Date.now();

      // Broadcast streams record every chunk so late joiners can catch up.
      const recordsChunks = def.kind === 'recorded' || def.broadcast === true;
      if (recordsChunks) {
        Storage.appendChunk(runtime.sql, {
          identity,
          streamId,
          seq,
          messageId: null,
          payload: serializeJsonOrThrow(
            chunkValue ?? null,
            `Durable stream chunk for "${def.event}"`,
          ),
          now,
        });

        if (def.maxChunks !== undefined) {
          const count = Storage.countChunks(runtime.sql, identity, streamId);
          if (count > def.maxChunks) {
            Storage.trimOldestChunks(runtime.sql, {
              identity,
              streamId,
              keepNewest: def.maxChunks,
            });

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
        const serializedCursor = serializeJsonOrThrow(
          cursorValue,
          `Durable stream cursor for "${def.event}"`,
        );
        Storage.updateCursor(runtime.sql, {
          identity,
          streamId,
          cursor: serializedCursor,
          lastSeq: seq,
          now,
        });
        // Save the cursor for this seq so a client that reconnects can go back
        // to the exact row it last got (see resumeDurableStream + readCursorAt).
        Storage.appendStreamCursor(runtime.sql, {
          identity,
          streamId,
          seq,
          cursor: serializedCursor,
        });
      } else {
        Storage.updateLastSeq(runtime.sql, { identity, streamId, lastSeq: seq, now });
      }

      const wirePayload = chunkToPayload(chunkValue);

      if (def.broadcast) {
        const targets = resolveBroadcastTargets({
          runtime,
          excludeConnectionId: connection.id,
          scope,
          // A late joiner has no row until it resumes, so it gets nothing live
          // until then — the resume backfill and the live tail never overlap.
          extraFilter: (candidate) => {
            const sub = Storage.getSubscriber(runtime.sql, {
              storageIdentity: identity,
              streamId,
              subscriberIdentity: storageIdentityOf(candidate),
            });
            return sub !== null && sub.unsubscribedAt === null && seq > sub.caughtUpSeq;
          },
        });
        // The pipeline adds streamId + seq to __wskit from the routing markers.
        forEachIsolated(
          targets,
          (target) =>
            runtime.sendThroughPipeline(target, {
              routing: {
                namespace: scope.namespace?.name,
                channel: scope.channelName,
                channelScope: scope.channelScope,
                streamId,
                seq,
                streamKind: 'persistent',
              },
              event: def.event,
              payload: wirePayload,
            }),
          {
            context: `durable stream broadcast fan-out streamId="${streamId}" event="${def.event}"`,
          },
        );
      }

      // Detached stream has no client attached — skip the wire send, the chunk
      // is already buffered for a later resume.
      const wireTarget = activeStream.connection ?? connection;
      if (!activeStream.detached) {
        runtime.sendThroughPipeline(wireTarget, {
          routing: {
            namespace: scope.namespace?.name,
            channel: scope.channelName,
            channelScope: scope.channelScope,
            streamId,
            seq,
            streamKind: 'persistent',
          },
          event: def.event,
          payload: wirePayload,
        });
      }

      if (hasNudges) {
        nextInput = [...nudgeBuffer];
        nudgeBuffer.length = 0;
      }
    }

    if (activeStream.closed) {
      // Only suspend if still active — a cancel would have deleted the row.
      const row = Storage.readStream(runtime.sql, identity, streamId);
      if (row && row.status === 'active') {
        Storage.markSuspended(runtime.sql, { identity, streamId, now: Date.now() });
      }
      return;
    }

    Storage.markEnded(runtime.sql, { identity, streamId, now: Date.now() });
    runtime.sendProtocolMessage(connection, {
      event: '__streamEnd__',
      payload: {},
      wskit: { ...buildScopeRouting(scope), streamId, seq },
    });
    if (def.broadcast) {
      // Tell every subscriber the source generator finished.
      const peerTargets = resolveBroadcastTargets({
        runtime,
        excludeConnectionId: connection.id,
        scope,
        extraFilter: (candidate) => {
          const sub = Storage.getSubscriber(runtime.sql, {
            storageIdentity: identity,
            streamId,
            subscriberIdentity: storageIdentityOf(candidate),
          });
          return sub !== null && sub.unsubscribedAt === null;
        },
      });

      const endWSKit = { ...buildScopeRouting(scope), streamId, seq, eventName: def.event };
      forEachIsolated(
        peerTargets,
        (target) =>
          runtime.sendProtocolMessage(target, {
            event: '__streamEnd__',
            payload: {},
            wskit: endWSKit,
          }),
        { context: `durable broadcast __streamEnd__ fan-out streamId="${streamId}"` },
      );
    }
  } catch (error) {
    rethrowIfConfigError(error);
    const routing: Protocol.WSKitRouting = { streamId, streamTerminated: true };
    if (scope.namespace?.name) routing.namespace = scope.namespace.name;
    if (scope.channelName) routing.channel = scope.channelName;
    if (scope.channelScope) routing.channelScope = scope.channelScope;
    await runtime.handleRuntimeError(connection, {
      error,
      event: def.event,
      routing,
    });
    // For broadcast streams, tell every subscriber the source died — with the
    // same terminal __error__ the creator gets (not a misleading clean end), so
    // their onError fires instead of them waiting indefinitely.
    if (def.broadcast) {
      const peerTargets = resolveBroadcastTargets({
        runtime,
        excludeConnectionId: connection.id,
        scope,
        extraFilter: (candidate) => {
          const sub = Storage.getSubscriber(runtime.sql, {
            storageIdentity: identity,
            streamId,
            subscriberIdentity: storageIdentityOf(candidate),
          });
          return sub !== null && sub.unsubscribedAt === null;
        },
      });
      const { payload, wskit } = normalizeRuntimeError(error, routing, runtime.declaredErrorCodes);
      const peerWSKit = { ...wskit, eventName: def.event };
      forEachIsolated(
        peerTargets,
        (target) =>
          runtime.sendProtocolMessage(target, { event: '__error__', payload, wskit: peerWSKit }),
        { context: `durable broadcast __error__ on error streamId="${streamId}"` },
      );
    }
    Storage.markEnded(runtime.sql, { identity, streamId, now: Date.now() });
  } finally {
    activeStream.closed = true;

    // Don't remove a slot a resume run has already taken over.
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
  opts: { streamId: string; cancelScope: ResolvedScope },
): Promise<void> {
  const { streamId, cancelScope } = opts;
  const realIdentity = storageIdentityOf(connection);
  const row = findResumeRow(runtime, connection, { resumeScope: cancelScope, streamId });
  if (!row) return;

  if (row.broadcast && row.creatorIdentity && row.creatorIdentity !== realIdentity) {
    // A non-creator cancel only unsubscribes them; the stream keeps running.
    Storage.markUnsubscribed(runtime.sql, {
      storageIdentity: row.identity,
      streamId,
      subscriberIdentity: realIdentity,
      now: Date.now(),
    });
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

  // Broadcast cancel from the creator kills the stream for everyone — tell
  // current subscribers before the storage row is deleted, otherwise their
  // clients keep waiting on a stream that will never produce again.
  if (row.broadcast) {
    const peerTargets = resolveBroadcastTargets({
      runtime,
      excludeConnectionId: connection.id,
      scope: cancelScope,
      extraFilter: (candidate) => {
        const sub = Storage.getSubscriber(runtime.sql, {
          storageIdentity: row.identity,
          streamId,
          subscriberIdentity: storageIdentityOf(candidate),
        });
        return sub !== null && sub.unsubscribedAt === null;
      },
    });
    const endWSKit = { ...buildScopeRouting(cancelScope), streamId, seq: row.lastSeq };
    forEachIsolated(
      peerTargets,
      (target) =>
        runtime.sendProtocolMessage(target, {
          event: '__streamEnd__',
          payload: {},
          wskit: endWSKit,
        }),
      { context: `durable broadcast __streamEnd__ on cancel streamId="${streamId}"` },
    );
  }

  Storage.deleteStream(runtime.sql, row.identity, streamId);
}
