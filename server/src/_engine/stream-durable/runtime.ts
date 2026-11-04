/* oxlint-disable @typescript-eslint/no-explicit-any */

import {
  DurableStreamRequiresUser,
  isLiveThingConfigError,
  rethrowIfConfigError,
  StreamAborted,
  StreamIdCollision,
} from '@livething/core';
import { connectionCall, inConnectionCall, withConnectionCall } from '~/_engine/async-context.ts';
import { forEachIsolated } from '~/_engine/runtime/isolation.ts';
import { serializeDurableChunk, serializeJsonOrThrow } from '~/_engine/runtime/json-guard.ts';
import { connectionStorageKeyOf, RESERVED_USER_ID_PREFIX } from '~/_engine/runtime/user-key.ts';
import { serializeWireFrame } from '~/_engine/runtime/wire-serialize.ts';
import {
  abortActiveStream,
  assertNoConcurrentStream,
  buildActiveStream,
  buildDrain,
  installCtxDrain,
  installCtxNudges,
  installCtxSignal,
  resolveBroadcastTargets,
} from '~/_engine/stream-common/active-stream.ts';
import { normalizeRuntimeError } from '~/errors/runtime.ts';
import type { EngineAsyncContext } from '~/_engine/async-context.ts';
import type * as Protocol from '~/_engine/runtime/protocol.ts';
import type {
  ActiveStream,
  ResolvedChannel,
  RoutingTarget,
  RuntimeConnection,
} from '~/_engine/runtime/types.ts';
import type { Logger } from '~/context.ts';
import type { SharedSend, SharedSendOptions } from '~/outgoing/runtime.ts';
import * as Storage from './storage.ts';

const USER_PURGED = 'user-purged';

type OptsParameter = {
  event: string;
  payload: Record<string, unknown>;
  livething: Record<string, unknown>;
};
type OptsParameter2 = { routing: RoutingTarget | undefined; event: string; payload: unknown };
type OptionsParameter = { force?: boolean };
type OptsParameter3 = { error: unknown; event?: string; routing?: Protocol.LiveThingRouting };
type EnsureUniqueStreamIdOptsParameter = { streamId: string; storageUserId: string };
type FindContinueRowOptsParameter = { continueScope: ResolvedChannel; streamId: string };
type SweepDurableStreamsRuntimeParameter = { sql: DurableStreamRuntime['sql'] };
type CancelDurableStreamOptsParameter = { streamId: string; cancelScope: ResolvedChannel };

/**
 * Synthetic key used as the storage row's `user_id` column for broadcast
 * durable streams. Encodes the scope (top-level / channel / channel-family)
 * so every connection in scope can resolve the same row regardless of which
 * user is holding the lookup.
 */
export function computeBroadcastKey(scope: ResolvedChannel): string {
  // Built from the reserved prefix rather than spelling it out, so these keys
  // cannot drift out of the namespace a real user id is barred from using.
  const bcast = `${RESERVED_USER_ID_PREFIX}bcast`;
  if (scope.channelName) {
    // The family key and channel name both may contain ':', so a plain-string
    // delimiter can collide (family 'a:' + name 'b' vs family 'a' + name ':b').
    // JSON-encode the pair instead: distinct pairs always encode distinctly.
    return scope.channelFamily
      ? `${bcast}:chf:${JSON.stringify([scope.channelFamily, scope.channelName])}__`
      : `${bcast}:ch:${scope.channelName}__`;
  }

  return `${bcast}:top__`;
}

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
    scope?: ResolvedChannel,
  ): Record<PropertyKey, unknown>;

  sendProtocolMessage(connection: RuntimeConnection, opts: OptsParameter): void;

  sendThroughPipeline(connection: RuntimeConnection, opts: OptsParameter2): boolean;

  openSharedSend(opts: SharedSendOptions): SharedSend;

  asyncContext: EngineAsyncContext;

  persistAttachment(connection: RuntimeConnection, options?: OptionsParameter): void;

  /** SQLite handle. */
  sql: {
    exec(query: string, ...params: unknown[]): { toArray(): Record<string, unknown>[] };
    transaction<T>(fn: () => T): T;
  };

  handleRuntimeError(connection: RuntimeConnection, opts: OptsParameter3): Promise<void>;
}

/** Engine-side snapshot of one nudge declaration: wire event + optional validator. */
interface DurableNudge {
  readonly event: string;
  readonly validator?: unknown;
}

/** Snapshot of one durable stream definition relevant to the runtime. */
export interface DurableStreamRuntimeDef {
  readonly event: string;

  readonly generator: (ctx: any, payload: any) => AsyncGenerator<unknown, void, unknown>;

  readonly allowConcurrent: boolean;

  readonly broadcast?: boolean;

  readonly nudges?: readonly DurableNudge[];

  readonly maxChunks?: number;

  readonly maxAgeMs?: number;

  readonly retentionAfterEndMs?: number;
}

/** Build the `__livething` routing block for a durable-stream frame from a live scope. */
function buildScopeRouting(scope: ResolvedChannel): Partial<Protocol.LiveThingProtocol> {
  const livething: Partial<Protocol.LiveThingProtocol> = {};
  if (scope.channelName) livething.channel = scope.channelName;
  if (scope.channelFamily) livething.channelFamily = scope.channelFamily;
  return livething;
}

/** Build the `__livething` routing block from a stored stream row. */
function buildRowRouting(row: Storage.DurableStreamRow): Partial<Protocol.LiveThingProtocol> {
  const livething: Partial<Protocol.LiveThingProtocol> = {};

  if (row.channelKey) livething.channel = row.channelKey;
  if (row.channelFamily) livething.channelFamily = row.channelFamily;

  return livething;
}

/**
 * Send buffered chunks to a connection using pre-built wire frames.
 *
 * Each chunk's payload is already a valid JSON string in the database (it was
 * `JSON.stringify`-ed on write), so we splice it directly into the frame
 * string rather than parse → spread → re-stringify per chunk. The constant
 * parts of `__livething` (scope markers + streamId) are also serialized once
 * before the loop, then only the per-chunk `streamSeq` (a plain number) and the
 * optional `messageId` are appended.
 */
interface SendChunkFramesOpts {
  eventName: string;

  chunks: Storage.DurableStreamChunkRow[];

  scopeMarkers: Record<string, unknown>;

  streamId: string;
}

function sendChunkFrames(connection: RuntimeConnection, opts: SendChunkFramesOpts): boolean {
  const { eventName, chunks, scopeMarkers, streamId } = opts;
  if (chunks.length === 0) return true;

  for (const chunk of chunks) {
    const wire = serializeWireFrame(eventName, JSON.parse(chunk.payload), {
      ...scopeMarkers,
      streamId,
      streamDurability: 'persistent',
      streamSeq: chunk.seq,
      ...(chunk.messageId === null ? {} : { messageId: chunk.messageId }),
    });

    if (connection.descriptor.send(wire) === false || connection.closing) return false;
  }

  return true;
}

function ensureUniqueStreamId(
  runtime: DurableStreamRuntime,
  opts: EnsureUniqueStreamIdOptsParameter,
): void {
  const { streamId, storageUserId } = opts;
  if (runtime.activeStreams.has(streamId)) throw StreamIdCollision();

  // Same stream id already active under this storage key on another socket.
  const row = Storage.readStream(runtime.sql, storageUserId, streamId);

  if (row && row.status === 'active') throw StreamIdCollision();
}

export interface RunDurableStreamOptions {
  scope: ResolvedChannel;
  def: DurableStreamRuntimeDef;
  payload: unknown;
  livething: Protocol.LiveThingProtocol | undefined;
}

/** Start a fresh durable stream from a client trigger frame. */
export async function runDurableStream(
  runtime: DurableStreamRuntime,
  connection: RuntimeConnection,
  opts: RunDurableStreamOptions,
): Promise<void> {
  const { scope, def, payload, livething } = opts;

  // A durable stream keys its stored state by the user id so a reconnect can
  // continue it. An anonymous connection has no stable id to continue against, so
  // refuse rather than write state that can never be reached again.
  if (!connection.userId) throw DurableStreamRequiresUser();

  const creatorUserId = connectionStorageKeyOf(connection);

  // Broadcast streams key the row by scope so every subscriber finds the same row.
  const storageUserId = def.broadcast ? computeBroadcastKey(scope) : creatorUserId;

  assertNoConcurrentStream(runtime, connection, {
    event: def.event,
    allowConcurrent: def.allowConcurrent,
  });

  // The wire schema already bounds and non-empties `streamId` (`StreamIdString`),
  // so its presence is the only thing left to check.
  const streamId = livething?.streamId ?? runtime.generateId('dstream');
  ensureUniqueStreamId(runtime, { streamId, storageUserId });

  const now = Date.now();
  Storage.insertStream(runtime.sql, {
    userId: storageUserId,
    streamId,
    event: def.event,
    payload: serializeJsonOrThrow(
      payload ?? null,
      `Durable stream trigger payload for "${def.event}"`,
    ),
    now,
    channelKey: scope.channelName ?? null,
    channelFamily: scope.channelFamily ?? null,
    broadcast: def.broadcast ?? false,
    creatorUserId,
    maxChunks: def.maxChunks,
    maxAgeMs: def.maxAgeMs,
    retentionAfterEndMs: def.retentionAfterEndMs,
  });

  // Seed everyone already in the scope; a late joiner gets its row on reconnect.

  if (def.broadcast) {
    for (const member of resolveBroadcastTargets({
      runtime,
      excludeConnectionId: connection.id,
      scope,
    })) {
      Storage.seedSubscriber(runtime.sql, {
        storageUserId,
        streamId,
        subscriberUserId: connectionStorageKeyOf(member),
      });
    }
  }

  try {
    runtime.sendProtocolMessage(connection, {
      event: '__streamOk__',
      payload: {},
      livething: { ...buildScopeRouting(scope), streamId, streamDurability: 'persistent' },
    });
  } catch (error) {
    Storage.deleteStream(runtime.sql, storageUserId, streamId);
    throw error;
  }

  if (connection.closing) {
    Storage.deleteStream(runtime.sql, storageUserId, streamId);
    return;
  }

  await runGenerator(runtime, connection, {
    scope,
    def,
    payload,
    streamId,
    userId: storageUserId,
  });
}

/**
 * Look up the durable-stream row for a `__continueStream__` frame. Tries the
 * connection's own user id first, then the broadcast channel key. Returns null
 * when nothing matches.
 */
export function findContinueRow(
  runtime: DurableStreamRuntime,
  connection: RuntimeConnection,
  opts: FindContinueRowOptsParameter,
): Storage.DurableStreamRow | null {
  const { continueScope, streamId } = opts;

  const realUserId = connectionStorageKeyOf(connection);

  const single = Storage.readStream(runtime.sql, realUserId, streamId);
  if (single) return single;

  const scopeKey = computeBroadcastKey(continueScope);

  return Storage.readStream(runtime.sql, scopeKey, streamId);
}

export interface ContinueDurableStreamOptions {
  resolveDef: (
    row: Storage.DurableStreamRow,
  ) => { def: DurableStreamRuntimeDef; scope: ResolvedChannel } | undefined;
  row: Storage.DurableStreamRow | null;
  streamId: string;
  lastKnownSeq: number;
}

/** What a creator's reconnect changed on a running stream, so a failed reattach can undo it. */
interface ContinueAttachment {
  runtime: DurableStreamRuntime;
  connection: RuntimeConnection;
  stream: ActiveStream;
  streamId: string;
  previousConnection: ActiveStream['connection'];
  previousConnectionId: ActiveStream['connectionId'];
  previousDetached: ActiveStream['detached'];
}

function rollbackContinueAttachment(attachment: ContinueAttachment, persist = true): void {
  const { runtime, connection, stream, streamId } = attachment;
  stream.connection = attachment.previousConnection;
  stream.connectionId = attachment.previousConnectionId;
  stream.detached = attachment.previousDetached;
  connection.activeStreamIds?.delete(streamId);

  if (persist) runtime.persistAttachment(connection, { force: true });
}

/**
 * A new connection took a running stream from a connection still attached to it
 * (another tab, or this client's half-open old socket). The old connection gets a
 * terminal `stream-aborted` with reason `taken-over`, so it is not left waiting.
 * A socket that cannot take the frame anymore needs no telling.
 */
function endStreamForPreviousConnection(
  attachment: ContinueAttachment,
  routing: Protocol.LiveThingRouting,
): void {
  const { runtime, connection, streamId, previousConnection, previousDetached } = attachment;
  if (previousDetached || !previousConnection || previousConnection === connection) return;

  previousConnection.activeStreamIds?.delete(streamId);
  runtime.persistAttachment(previousConnection);
  if (previousConnection.closing) return;

  try {
    runtime.sendProtocolMessage(previousConnection, {
      event: '__error__',
      payload: { code: StreamAborted.code, detail: { reason: 'taken-over' as const } },
      livething: { ...routing, streamTerminated: true },
    });
  } catch {
    // The takeover already happened; the old socket is on its way out.
  }
}

/**
 * Handle a client `__continueStream__` frame. Replays the chunks the client
 * missed, then: reattaches a creator to a still-running generator (ending the
 * stream for a connection still attached to it, with reason `taken-over`), leaves a
 * subscriber on the live broadcast, sends `__streamEnd__` for a stream that
 * finished, or a terminal `stream-aborted` `'interrupted'` error for a stream
 * whose generator stopped before it finished.
 */
export async function continueDurableStream(
  runtime: DurableStreamRuntime,
  connection: RuntimeConnection,
  opts: ContinueDurableStreamOptions,
): Promise<void> {
  const { resolveDef, streamId, lastKnownSeq } = opts;
  let { row } = opts;
  const cancelling = connection.cancellingStreams?.get(streamId);
  if (cancelling) {
    // A cancel sent before this continue is still stopping the generator. Wait
    // for it, then read the row again: a finished cancel has deleted it.
    await cancelling;
    row = row && Storage.readStream(runtime.sql, row.userId, streamId);
  }

  if (!row) {
    runtime.sendProtocolMessage(connection, {
      event: '__error__',
      payload: { code: StreamAborted.code, detail: { reason: 'not-found' as const } },
      livething: { streamId },
    });
    return;
  }

  // Membership comes first: someone outside the channel may not delete a row, or
  // learn that it expired.
  const resolved = resolveDef(row);
  if (!resolved) {
    runtime.sendProtocolMessage(connection, {
      event: '__error__',
      payload: { code: StreamAborted.code, detail: { reason: 'not-found' as const } },
      livething: { streamId },
    });
    return;
  }

  const nowAtContinue = Date.now();
  if (
    row.status === 'suspended' &&
    row.maxAgeMs != null &&
    row.lastActivityAt + row.maxAgeMs < nowAtContinue
  ) {
    Storage.deleteStream(runtime.sql, row.userId, streamId);
    runtime.sendProtocolMessage(connection, {
      event: '__error__',
      payload: { code: StreamAborted.code, detail: { reason: 'expired' as const } },
      livething: { ...buildRowRouting(row), streamId },
    });
    return;
  }

  if (
    row.status === 'ended' &&
    row.endedAt != null &&
    row.retentionAfterEndMs != null &&
    row.endedAt + row.retentionAfterEndMs < nowAtContinue
  ) {
    Storage.deleteStream(runtime.sql, row.userId, streamId);
    runtime.sendProtocolMessage(connection, {
      event: '__error__',
      payload: { code: StreamAborted.code, detail: { reason: 'not-found' as const } },
      livething: { ...buildRowRouting(row), streamId },
    });
    return;
  }

  const storageUserId = row.userId;
  const realUserIdForGuard = connectionStorageKeyOf(connection);
  if (
    row.broadcast &&
    Storage.isUnsubscribed(runtime.sql, {
      storageUserId,
      streamId,
      subscriberUserId: realUserIdForGuard,
    })
  ) {
    runtime.sendProtocolMessage(connection, {
      event: '__error__',
      payload: { code: StreamAborted.code, detail: { reason: 'unsubscribed' as const } },
      livething: { streamId },
    });
    return;
  }

  const { def } = resolved;

  const realUserId = realUserIdForGuard;
  // A subscriber (not the creator) on a broadcast stream.
  const isPeerSubscriber =
    row.broadcast && row.creatorUserId !== null && row.creatorUserId !== realUserId;

  const scopeMarkers = buildRowRouting(row);

  // Creator reconnects to a stream whose generator is still running (its old
  // socket dropped, or is half-open and not yet noticed): point it at the new
  // connection and replay buffered chunks.
  const live = runtime.activeStreams.get(streamId);
  if (!isPeerSubscriber && row.status === 'active' && live && !live.closed) {
    const previousConnection = live.connection;
    const previousConnectionId = live.connectionId;
    const previousDetached = live.detached;
    live.connection = connection;
    live.connectionId = connection.id;

    live.detached = false;

    if (!connection.activeStreamIds) connection.activeStreamIds = new Set();

    connection.activeStreamIds.add(streamId);
    const attachment: ContinueAttachment = {
      runtime,
      connection,
      stream: live,
      streamId,
      previousConnection,
      previousConnectionId,
      previousDetached,
    };

    try {
      runtime.persistAttachment(connection);
    } catch (error) {
      rollbackContinueAttachment(attachment, false);
      throw error;
    }

    try {
      runtime.sendProtocolMessage(connection, {
        event: '__streamOk__',
        payload: {},
        livething: { ...scopeMarkers, streamId, streamDurability: 'persistent' },
      });
    } catch (error) {
      rollbackContinueAttachment(attachment);
      throw error;
    }

    if (connection.closing) {
      rollbackContinueAttachment(attachment);
      return;
    }

    const chunks = Storage.readChunksSince(runtime.sql, {
      userId: storageUserId,
      streamId,
      since: lastKnownSeq,
    });

    try {
      if (!sendChunkFrames(connection, { eventName: def.event, chunks, scopeMarkers, streamId })) {
        rollbackContinueAttachment(attachment);
        return;
      }
    } catch (error) {
      rollbackContinueAttachment(attachment);
      throw error;
    }

    endStreamForPreviousConnection(attachment, { ...scopeMarkers, streamId });

    return;
  }

  const chunks = Storage.readChunksSince(runtime.sql, {
    userId: storageUserId,
    streamId,
    since: lastKnownSeq,
  });

  if (!sendChunkFrames(connection, { eventName: def.event, chunks, scopeMarkers, streamId })) {
    return;
  }

  if (isPeerSubscriber) {
    const caughtUpSeq = chunks.length > 0 ? chunks[chunks.length - 1]!.seq : lastKnownSeq;

    Storage.setCaughtUpSeq(runtime.sql, {
      storageUserId,
      streamId,
      subscriberUserId: realUserId,
      caughtUpSeq,
    });
  }

  if (row.status === 'ended' && !row.interrupted) {
    runtime.sendProtocolMessage(connection, {
      event: '__streamEnd__',
      payload: {},
      livething: { ...scopeMarkers, streamId, streamSeq: row.lastSeq, eventName: def.event },
    });
    return;
  }

  // A subscriber caught up from the buffer; future chunks come via the broadcast.
  if (row.status !== 'ended' && live && !live.closed) return;

  // The generator stopped before it finished and will never run again, so a
  // plain end would pass a cut-off stream off as complete.
  if (row.status !== 'ended') {
    Storage.markEnded(runtime.sql, {
      userId: storageUserId,
      streamId,
      now: Date.now(),
      interrupted: true,
    });
  }

  runtime.sendProtocolMessage(connection, {
    event: '__error__',
    payload: { code: StreamAborted.code, detail: { reason: 'interrupted' as const } },
    livething: { ...scopeMarkers, streamId, streamTerminated: true, eventName: def.event },
  });
}

/** Delete suspended rows past `maxAgeMs` and ended rows past `retentionAfterEndMs`. */
export function sweepDurableStreams(runtime: SweepDurableStreamsRuntimeParameter): number {
  const now = Date.now();
  let deleted = 0;
  for (const candidate of Storage.findExpiredSuspended(runtime.sql, now)) {
    Storage.deleteStream(runtime.sql, candidate.userId, candidate.streamId);
    deleted += 1;
  }

  for (const candidate of Storage.findExpiredEnded(runtime.sql, now)) {
    Storage.deleteStream(runtime.sql, candidate.userId, candidate.streamId);
    deleted += 1;
  }

  return deleted;
}

interface RunGeneratorOptions {
  scope: ResolvedChannel;
  def: DurableStreamRuntimeDef;
  payload: unknown;
  streamId: string;
  userId: string;
}

interface LiveChunkOptions {
  def: DurableStreamRuntimeDef;
  scope: ResolvedChannel;
  streamId: string;
  userId: string;
  seq: number;
  payload: Record<string, unknown>;
  /** The connection that started the stream; a broadcast never sends it a peer copy. */
  creator: RuntimeConnection;
  /** The socket that gets the creator's copy: the reattached connection, if any. */
  wireTarget: RuntimeConnection;
  /** Whether the creator is gone and only peers (if any) get the chunk. */
  detached: boolean;
}

/**
 * Send one live chunk to the creator's socket and, for a broadcast stream, to every caught-up
 * subscriber — one shared frame for all of them. Returns `false` when the creator's socket
 * refused it.
 */
function sendLiveChunk(runtime: DurableStreamRuntime, opts: LiveChunkOptions): boolean {
  const { def, scope, streamId, userId, seq, payload, creator, wireTarget, detached } = opts;
  // The pipeline adds streamId + streamSeq to __livething from the routing markers.
  const routing = {
    channel: scope.channelName,
    channelFamily: scope.channelFamily,
    streamId,
    streamSeq: seq,
    streamDurability: 'persistent' as const,
  };

  if (!def.broadcast) {
    return (
      detached || runtime.sendThroughPipeline(wireTarget, { routing, event: def.event, payload })
    );
  }

  const targets = resolveBroadcastTargets({
    runtime,
    excludeConnectionId: creator.id,
    scope,
    // A late joiner has no row until it continues, so it gets nothing live
    // until then — the reconnect backfill and the live tail never overlap.
    extraFilter: (candidate) => {
      const sub = Storage.getSubscriber(runtime.sql, {
        storageUserId: userId,
        streamId,
        subscriberUserId: connectionStorageKeyOf(candidate),
      });
      return sub !== null && sub.unsubscribedAt === null && seq > sub.caughtUpSeq;
    },
  });
  const chunkSend = runtime.openSharedSend({
    routing,
    event: def.event,
    payload,
    target: scope.channelName ? { kind: 'channel' } : { kind: 'all' },
  });
  try {
    forEachIsolated(targets, (target) => chunkSend.deliver(target), {
      context: `durable stream broadcast fan-out streamId="${streamId}" event="${def.event}"`,
    });
    return detached || chunkSend.deliver(wireTarget);
  } finally {
    chunkSend.finish();
  }
}

async function runGenerator(
  runtime: DurableStreamRuntime,
  connection: RuntimeConnection,
  opts: RunGeneratorOptions,
): Promise<void> {
  const { scope, def, payload, streamId, userId } = opts;
  const ctx = runtime.buildConnectionContext(connection, scope) as Record<PropertyKey, unknown>;
  installCtxNudges(ctx);
  const abortController = new AbortController();
  installCtxSignal(ctx, abortController);

  // Single failure boundary: generator creation, registration, iteration, and
  // status changes all run inside the try so no path can leave the DB row
  // 'active'. A synchronous throw from def.generator(...) is caught here too.
  let activeStream: ActiveStream | undefined;
  let seq = 0;

  installCtxDrain(
    ctx,
    buildDrain({
      // Broadcast paces against the healthiest of every live target; a single
      // durable stream against the connection it is currently attached to.
      targets: () => {
        const wireTarget = activeStream?.connection ?? connection;
        if (!def.broadcast) return [wireTarget];

        return [
          wireTarget,
          ...resolveBroadcastTargets({ runtime, excludeConnectionId: connection.id, scope }),
        ];
      },
      isClosed: () => activeStream?.closed ?? false,
    }),
  );

  // A run "owns the slot" while no *other* ActiveStream holds this streamId. A
  // continue/replace with the same streamId swaps in a new ActiveStream; once
  // that happens the superseded run must not touch the shared row, attachment, or
  // wire — doing so would corrupt the replacement. Before this run registers
  // (activeStream undefined) the slot is its own to manage.
  function stillOwnsSlot(): boolean {
    if (!activeStream) return true;

    const current = runtime.activeStreams.get(streamId);
    return current === undefined || current === activeStream;
  }

  function attachedConnection(): RuntimeConnection | undefined {
    if (activeStream?.detached) return undefined;

    return activeStream?.connection ?? connection;
  }

  let iterator: AsyncGenerator<unknown, void, unknown> | undefined;
  try {
    const streamCall = connectionCall(connection.id, scope, () => ctx);
    iterator = inConnectionCall(
      runtime.asyncContext,
      streamCall,
      withConnectionCall(runtime.asyncContext, streamCall, () =>
        def.generator(ctx, payload),
      ) as AsyncGenerator<unknown, void, unknown>,
    );
    const built = buildActiveStream({
      streamId,
      event: def.event,
      connection,
      generator: iterator,
      nudges: def.nudges ?? [],
      scope,
      abortController,
      durable: true,
    });
    activeStream = built.active;
    const nudgeBuffer = built.nudgeBuffer;

    runtime.activeStreams.set(streamId, activeStream);
    if (!connection.activeStreamIds) connection.activeStreamIds = new Set();
    connection.activeStreamIds.add(streamId);
    runtime.persistAttachment(connection);

    const hasNudges = (def.nudges?.length ?? 0) > 0;
    let nextInput: unknown = hasNudges ? [] : undefined;

    while (!activeStream.closed) {
      // The wrapped iterator runs inside the connection's async context, so plugin
      // APIs the generator calls (e.g. hooks.getState()) resolve to the stream owner.
      const result = await iterator.next(nextInput);
      if (abortController.signal.reason === USER_PURGED) return;

      if (result.done) break;

      // A reconnect/replace took over this streamId while next() was pending. This
      // superseded run no longer owns the slot, so it must stop before persisting or
      // sending — its work would corrupt the replacement's shared state.
      if (!stillOwnsSlot()) return;

      // A stream stopped because its connection left the channel keeps nothing.
      if (activeStream.closed && abortController.signal.reason === 'unsubscribed') break;

      seq += 1;
      const now = Date.now();

      // One serialization: stored as is, and parsed once for the live frames.
      const chunkJson = serializeDurableChunk(def.event, result.value);
      const wirePayload = JSON.parse(chunkJson) as Record<string, unknown>;

      if (def.maxChunks !== undefined) {
        // Seed from storage once (covers a continued stream's existing rows),
        // then count in memory instead of a COUNT(*) per chunk.
        activeStream.recordedChunkCount ??= Storage.countChunks(runtime.sql, userId, streamId);

        // The chunk that would go over the limit is neither stored nor sent, so the end
        // frame's seq stays the last chunk the client got.
        if (activeStream.recordedChunkCount >= def.maxChunks) {
          seq -= 1;
          try {
            await iterator.throw(StreamAborted({ reason: 'buffer-full' }));
          } catch (err) {
            rethrowIfConfigError(err);
            throw err;
          }

          break;
        }

        activeStream.recordedChunkCount += 1;
      }

      Storage.appendChunk(runtime.sql, {
        userId,
        streamId,
        seq,
        messageId: null,
        payload: chunkJson,
      });

      // No function is declared inside this loop: the Cloudflare bundle hoisted one out of the
      // block, and its minified name hid the imported `buildActiveStream`.
      Storage.updateLastSeq(runtime.sql, { userId, streamId, lastSeq: seq, now });

      // A replacement may have taken the slot during the maxChunks iterator.throw
      // above; never send a chunk once this run no longer owns the stream.
      if (!stillOwnsSlot()) return;

      const sent = sendLiveChunk(runtime, {
        def,
        scope,
        streamId,
        userId,
        seq,
        payload: wirePayload,
        creator: connection,
        wireTarget: activeStream.connection ?? connection,
        detached: !!activeStream.detached,
      });
      // The owner's socket is gone: keep recording so a reconnect can replay.
      if (!sent) activeStream.detached = true;

      if (hasNudges) {
        nextInput = [...nudgeBuffer];
        nudgeBuffer.length = 0;
      }
    }

    if (activeStream.closed) {
      // Only suspend if still active and this run still owns the slot — a
      // replacement would otherwise have its 'active' row flipped to 'suspended'.
      const row = Storage.readStream(runtime.sql, userId, streamId);
      if (row && row.status === 'active' && stillOwnsSlot()) {
        Storage.markSuspended(runtime.sql, { userId, streamId, now: Date.now() });
      }

      return;
    }

    // A replacement run owns the row now; ending it would kill the live stream.
    if (!stillOwnsSlot()) return;

    Storage.markEnded(runtime.sql, { userId, streamId, now: Date.now() });
    const ownerConnection = attachedConnection();
    if (ownerConnection && !ownerConnection.closing) {
      runtime.sendProtocolMessage(ownerConnection, {
        event: '__streamEnd__',
        payload: {},
        livething: { ...buildScopeRouting(scope), streamId, streamSeq: seq },
      });
    }

    if (def.broadcast) {
      // Tell every subscriber the source generator finished.
      const peerTargets = resolveBroadcastTargets({
        runtime,
        excludeConnectionId: connection.id,
        scope,
        extraFilter: (candidate) => {
          const sub = Storage.getSubscriber(runtime.sql, {
            storageUserId: userId,
            streamId,
            subscriberUserId: connectionStorageKeyOf(candidate),
          });
          return sub !== null && sub.unsubscribedAt === null;
        },
      });

      const endLiveThing = {
        ...buildScopeRouting(scope),
        streamId,
        streamSeq: seq,
        eventName: def.event,
      };

      forEachIsolated(
        peerTargets,
        (target) =>
          runtime.sendProtocolMessage(target, {
            event: '__streamEnd__',
            payload: {},
            livething: endLiveThing,
          }),
        { context: `durable broadcast __streamEnd__ fan-out streamId="${streamId}"` },
      );
    }
  } catch (error) {
    // When LiveThing refused a chunk, the generator still waits at its yield. Close it, so its
    // finally blocks run. A generator that threw has already finished, so this does nothing.
    await iterator?.return(undefined).catch(() => {});

    if (abortController.signal.reason === USER_PURGED) return;

    // A config error must propagate, but the row still has to leave 'active' or
    // it blocks every future start/continue — mark it ended before rethrowing.
    // Only when this run still owns the slot; a replacement manages its own row.
    if (isLiveThingConfigError(error)) {
      if (stillOwnsSlot()) {
        Storage.markEnded(runtime.sql, { userId, streamId, now: Date.now(), interrupted: true });
      }

      throw error;
    }

    const routing: Protocol.LiveThingRouting = { streamId, streamTerminated: true };
    if (scope.channelName) routing.channel = scope.channelName;
    if (scope.channelFamily) routing.channelFamily = scope.channelFamily;
    const ownerConnection = attachedConnection();

    if (ownerConnection) {
      await runtime.handleRuntimeError(ownerConnection, {
        error,
        event: def.event,
        routing,
      });
    }

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
            storageUserId: userId,
            streamId,
            subscriberUserId: connectionStorageKeyOf(candidate),
          });
          return sub !== null && sub.unsubscribedAt === null;
        },
      });
      const normalized = normalizeRuntimeError(error, routing, runtime.declaredErrorCodes);
      const peerLiveThing = { ...normalized.livething, eventName: def.event };
      forEachIsolated(
        peerTargets,
        (target) =>
          runtime.sendProtocolMessage(target, {
            event: '__error__',
            payload: normalized.payload,
            livething: peerLiveThing,
          }),
        { context: `durable broadcast __error__ on error streamId="${streamId}"` },
      );
    }

    if (stillOwnsSlot()) {
      Storage.markEnded(runtime.sql, { userId, streamId, now: Date.now(), interrupted: true });
    }
  } finally {
    // A reconnect run may have already taken over this streamId. Only the run that
    // still owns the slot may tear down the shared connection/attachment state;
    // otherwise the superseded run would delete the replacement's activeStreamIds entry
    // and persist a stale attachment.
    const ownsSlot = stillOwnsSlot();
    if (activeStream) {
      activeStream.closed = true;
      if (ownsSlot) runtime.activeStreams.delete(streamId);
    }

    const ownerConnection = attachedConnection();
    if (ownsSlot && ownerConnection) {
      ownerConnection.activeStreamIds?.delete(streamId);
      runtime.persistAttachment(ownerConnection);
    }
  }
}

/**
 * Cancel a durable stream from a client `__streamCancel__` frame.
 *
 * - Single-subscriber stream: stop the generator, delete the row + chunks.
 * - Broadcast stream from the creator: same — kills it for everyone.
 * - Broadcast stream from a non-creator: add the caller's user id to
 *   the per-stream unsubscribed list so the fanout skips them. The source keeps
 *   running for everyone else.
 */
export async function cancelDurableStream(
  runtime: DurableStreamRuntime,
  connection: RuntimeConnection,
  opts: CancelDurableStreamOptsParameter,
): Promise<void> {
  const { streamId, cancelScope } = opts;
  const realUserId = connectionStorageKeyOf(connection);
  const row = findContinueRow(runtime, connection, { continueScope: cancelScope, streamId });
  if (!row) return;

  if (row.broadcast && row.creatorUserId && row.creatorUserId !== realUserId) {
    // A non-creator cancel only unsubscribes them; the stream keeps running.
    Storage.markUnsubscribed(runtime.sql, {
      storageUserId: row.userId,
      streamId,
      subscriberUserId: realUserId,
      now: Date.now(),
    });
    return;
  }

  const active = runtime.activeStreams.get(streamId);
  if (active && !active.closed) {
    active.closed = true;
    abortActiveStream(active, 'cancelled');
    try {
      await active.generator.return(undefined);
    } catch (error) {
      runtime.logger.warn('[livething] durable stream cleanup threw on cancel', {
        streamId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      runtime.activeStreams.delete(streamId);
      connection.activeStreamIds?.delete(streamId);
    }
  }

  endDurableStreamForEveryone(runtime, connection, { row, scope: cancelScope });
}

interface EndDurableStreamForEveryoneOptions {
  row: Storage.DurableStreamRow;
  scope: ResolvedChannel;
}

/**
 * Delete a durable stream for good. A broadcast stream first tells its current
 * subscribers with `__streamEnd__`, so their clients do not keep waiting on a
 * stream that will never produce again.
 */
function endDurableStreamForEveryone(
  runtime: DurableStreamRuntime,
  connection: RuntimeConnection,
  opts: EndDurableStreamForEveryoneOptions,
): void {
  const { row, scope } = opts;
  if (row.broadcast) tellBroadcastPeersStreamEnded(runtime, connection, { row, scope });

  Storage.deleteStream(runtime.sql, row.userId, row.streamId);
}

function tellBroadcastPeersStreamEnded(
  runtime: BroadcastPeersRuntime,
  connection: RuntimeConnection,
  opts: EndDurableStreamForEveryoneOptions,
): void {
  const { row, scope } = opts;
  const { streamId } = row;
  const peerTargets = resolveBroadcastTargets({
    runtime,
    excludeConnectionId: connection.id,
    scope,
    extraFilter: (candidate) => {
      const sub = Storage.getSubscriber(runtime.sql, {
        storageUserId: row.userId,
        streamId,
        subscriberUserId: connectionStorageKeyOf(candidate),
      });
      return sub !== null && sub.unsubscribedAt === null;
    },
  });
  const endLiveThing = {
    ...buildScopeRouting(scope),
    streamId,
    streamSeq: row.lastSeq,
    eventName: row.event,
  };

  forEachIsolated(
    peerTargets,
    (target) =>
      runtime.sendProtocolMessage(target, {
        event: '__streamEnd__',
        payload: {},
        livething: endLiveThing,
      }),
    { context: `durable broadcast __streamEnd__ on end streamId="${streamId}"` },
  );
}

type BroadcastPeersRuntime = Pick<
  DurableStreamRuntime,
  'connections' | 'sql' | 'sendProtocolMessage'
>;

type PurgedStreamsRuntime = BroadcastPeersRuntime & Pick<DurableStreamRuntime, 'activeStreams'>;

/**
 * Stop every recorded stream a purged user started: fire `ctx.stream.signal`, end the
 * generator, and tell broadcast subscribers it's over. Call it before the stream rows are
 * deleted, since the subscriber rows pick who to tell. It doesn't wait for the generator,
 * which may be stuck in a long `await`; the run stops at its next step.
 */
export function stopStreamsOfPurgedUser(runtime: PurgedStreamsRuntime, userId: string): void {
  for (const stream of [...runtime.activeStreams.values()]) {
    const owner = stream.connection;
    if (!stream.durable || owner?.userId !== userId) continue;

    stream.closed = true;
    stream.abortController.abort(USER_PURGED);
    stream.generator.return(undefined).catch(() => {});
    runtime.activeStreams.delete(stream.id);
    owner.activeStreamIds?.delete(stream.id);

    const row = Storage.readStreamOfCreator(runtime.sql, userId, stream.id);
    if (!row) continue;

    if (row.broadcast && stream.scope) {
      tellBroadcastPeersStreamEnded(runtime, owner, { row, scope: stream.scope });
    }

    Storage.markEnded(runtime.sql, { userId: row.userId, streamId: row.streamId, now: Date.now() });
  }
}

export interface EndDurableStreamOnLeaveOptions {
  streamId: string;
  scope: ResolvedChannel;
}

/**
 * Remove the stored row of a durable stream whose creator left the stream's
 * channel. The generator is already stopped by the caller. A non-member can
 * never continue it, so the row is deleted rather than suspended.
 */
export function endDurableStreamOnLeave(
  runtime: DurableStreamRuntime,
  connection: RuntimeConnection,
  opts: EndDurableStreamOnLeaveOptions,
): void {
  const { streamId, scope } = opts;
  const row = findContinueRow(runtime, connection, { continueScope: scope, streamId });
  if (!row) return;

  endDurableStreamForEveryone(runtime, connection, { row, scope });
}
