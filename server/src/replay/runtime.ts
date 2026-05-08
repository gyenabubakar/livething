import { ValidationFailed } from '@wskit/core';
import { ENGINE_SCOPE_META } from '~/_engine/contexts/types.ts';
import * as ChannelPrimitive from '~/channel/runtime.ts';
import type { EngineScopeMeta } from '~/_engine/contexts/types.ts';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';
import type {
  ReplayOptions,
  ReplayPayloadScope,
  ReplayRow,
  ReplaySnapshotValue,
  ReplayType,
} from '~/replay/types.ts';

const CREATE_REPLAY_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS _wskit_replay (
    rowKey TEXT PRIMARY KEY,
    messageId TEXT NOT NULL,
    seq INTEGER NOT NULL,
    event TEXT NOT NULL,
    payload TEXT NOT NULL,
    namespace TEXT,
    channel TEXT,
    channelScope TEXT,
    snapshotKey TEXT,
    createdAt INTEGER NOT NULL
  )
`;

const CREATE_REPLAY_SEQ_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_wskit_replay_seq
  ON _wskit_replay (seq)
`;

const CREATE_REPLAY_SCOPE_SEQ_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_wskit_replay_scope_seq
  ON _wskit_replay (channel, channelScope, seq)
`;

/**
 * Create the SQLite tables and indexes the automatic replay primitive needs.
 */
export function ensureReplaySchema(sql: {
  exec(query: string, ...params: unknown[]): unknown;
}): void {
  sql.exec(CREATE_REPLAY_TABLE_SQL);
  sql.exec(CREATE_REPLAY_SEQ_INDEX_SQL);
  sql.exec(CREATE_REPLAY_SCOPE_SEQ_INDEX_SQL);
}

/**
 * Decide whether one replay primitive instance owns the current scope.
 *
 * Channel replay handles only its own concrete channel or channel-family key.
 * Server-level replay handles every scope EXCEPT those claimed by another
 * replay primitive — channels that registered their own `.replay(...)` or
 * opted out via `.replay(false)`. That cascade behavior is what lets a single
 * top-level `withReplay` capture and serve replay for every unclaimed channel.
 */
export function matchesReplayScope(
  channelKey: string | undefined,
  scope: { namespaceName?: string; channelName?: string; channelScope?: string | null },
  claimedChannelKeys: ReadonlySet<string> = EMPTY_CLAIMED_CHANNEL_KEYS,
): boolean {
  if (channelKey) {
    return scope.channelScope === channelKey || scope.channelName === channelKey;
  }

  if (scope.channelScope && claimedChannelKeys.has(scope.channelScope)) return false;
  if (scope.channelName && claimedChannelKeys.has(scope.channelName)) return false;
  return true;
}

const EMPTY_CLAIMED_CHANNEL_KEYS: ReadonlySet<string> = new Set();

/**
 * Check whether a connection may receive replay rows for a channel-scoped
 * request. Non-channel requests pass through. Channel requests require live
 * membership in the same (channelName, channelScope) the request asks for.
 */
export function isChannelReplayAuthorized(
  connection: RuntimeConnection | undefined,
  scope: { channelName?: string },
  payload: Record<string, unknown> | undefined,
): boolean {
  if (!scope.channelName) return true;
  if (!connection) return false;
  const wireChannelScope: string | null =
    typeof payload?._channelScope === 'string' ? payload._channelScope : null;
  return ChannelPrimitive.hasChannelMembership(connection, scope.channelName, wireChannelScope);
}

/**
 * Read the hidden scope markers attached to one live connection ctx.
 */
export function readReplayContextScope(ctx: Record<PropertyKey, unknown>): EngineScopeMeta {
  return (ctx[ENGINE_SCOPE_META] as EngineScopeMeta | undefined) ?? {};
}

/**
 * Read replay scope markers from one final outgoing payload.
 */
export function readReplayPayloadScope(payload: Record<string, unknown>): ReplayPayloadScope {
  return {
    namespace: typeof payload._namespace === 'string' ? payload._namespace : null,
    channel: typeof payload._channel === 'string' ? payload._channel : null,
    channelScope: typeof payload._channelScope === 'string' ? payload._channelScope : null,
  };
}

/**
 * Read and validate the `since` cursor on an incoming `_replay` request.
 *
 * Sequence numbers are positive monotonic integers, so a valid cursor is a
 * non-negative integer. Anything else — undefined, fractional, negative,
 * non-finite, or a non-number — surfaces a typed validation error to the
 * client. Both built-in and custom replay run this check so a malformed
 * `since` never silently degrades to "match nothing" or "match everything".
 */
export function readReplaySinceCursor(payload: Record<string, unknown> | undefined): number {
  const raw = payload?.since;
  if (raw === undefined || raw === null) return 0;
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0) return raw;
  throw ValidationFailed({
    event: '_replay',
    issues: [
      {
        message: 'since must be a non-negative integer',
        path: ['since'],
      },
    ],
  });
}

/**
 * Decide whether one final outgoing message belongs to this replay instance.
 *
 * Channel-scoped replay only stores messages for its own channel. Server-level
 * replay (no `channelKey`) cascades — it stores messages for every scope
 * except the channels listed in `claimedChannelKeys`, which are the channels
 * that registered their own `.replay(...)` or disabled replay via
 * `.replay(false)`.
 *
 * Frames that carry `_correlationId` are private 1:1 request responses. They
 * never belong in a replay store — a different connection later asking for
 * `_replay` would receive somebody else's response.
 */
export function shouldStoreReplayMessage(
  channelKey: string | undefined,
  event: string,
  payload: Record<string, unknown>,
  exclude: ReadonlySet<string>,
  claimedChannelKeys: ReadonlySet<string> = EMPTY_CLAIMED_CHANNEL_KEYS,
): boolean {
  if (exclude.has(event)) return false;
  // Skip 1:1 request responses — they are addressed to one in-flight caller
  // via _correlationId and replaying them would hand a different client the
  // original requester's response.
  if (typeof payload._correlationId === 'string') return false;
  // Skip stream chunks. A stream chunk carries `_streamId` referencing one
  // active stream on the original connection. Re-sending it on a fresh
  // connection or a future reconnect would surface a phantom stream id the
  // client does not know about. Issue #3 tracks proper stream replay across
  // reconnect; until then, stream chunks are not replayable.
  if (typeof payload._streamId === 'string') return false;

  const scope = readReplayPayloadScope(payload);

  if (channelKey) {
    return scope.channelScope === channelKey || scope.channel === channelKey;
  }

  if (scope.channelScope && claimedChannelKeys.has(scope.channelScope)) return false;
  if (scope.channel && claimedChannelKeys.has(scope.channel)) return false;
  return true;
}

/**
 * Convert one final outgoing message into the replay row that should be stored.
 */
export function buildReplayRow(
  options: ReplayOptions,
  event: string,
  payload: Record<string, unknown>,
  now: number,
): ReplayRow {
  const seq = payload._seq;
  const messageId = payload._messageId;

  if (typeof seq !== 'number' || typeof messageId !== 'string') {
    throw new Error('[wskit] replay() requires sequence() and dedup() in the same scope.');
  }

  const scope = readReplayPayloadScope(payload);
  const type = options.type ?? 'history';
  const snapshotKey = type === 'snapshot' ? (options.snapshotKey?.(event, payload) ?? event) : null;

  return {
    rowKey: buildReplayRowKey(type, scope, messageId, snapshotKey),
    messageId,
    seq,
    event,
    payload: JSON.stringify(payload),
    namespace: scope.namespace,
    channel: scope.channel,
    channelScope: scope.channelScope,
    snapshotKey,
    createdAt: now,
  };
}

/**
 * Load one replay row by its primary key.
 *
 * Snapshot mode uses this to read the current stored value before applying a
 * reducer.
 */
export function getReplayRowByKey(
  sql: {
    exec<TRow = unknown>(query: string, ...params: unknown[]): { one(): TRow | null };
  },
  rowKey: string,
): ReplayRow | null {
  const row = sql
    .exec<ReplayRow>(
      `
        SELECT
          rowKey,
          messageId,
          seq,
          event,
          payload,
          namespace,
          channel,
          channelScope,
          snapshotKey,
          createdAt
        FROM _wskit_replay
        WHERE rowKey = ?
      `,
      rowKey,
    )
    .one();

  if (!row) return null;

  return {
    rowKey: String(row.rowKey),
    messageId: String(row.messageId),
    seq: Number(row.seq),
    event: String(row.event),
    payload: String(row.payload),
    namespace: (row.namespace as string | null) ?? null,
    channel: (row.channel as string | null) ?? null,
    channelScope: (row.channelScope as string | null) ?? null,
    snapshotKey: (row.snapshotKey as string | null) ?? null,
    createdAt: Number(row.createdAt),
  };
}

/**
 * Delete one replay row by key.
 *
 * Snapshot reducers use this when they return `null`.
 */
export function deleteReplayRow(
  sql: {
    exec(query: string, ...params: unknown[]): unknown;
  },
  rowKey: string,
): void {
  sql.exec(
    `
      DELETE FROM _wskit_replay
      WHERE rowKey = ?
    `,
    rowKey,
  );
}

/**
 * Convert a stored replay row into the reducer-facing snapshot value shape.
 */
export function toReplaySnapshotValue(row: ReplayRow): ReplaySnapshotValue {
  return {
    event: row.event,
    payload: stripSnapshotMetadata(JSON.parse(row.payload) as Record<string, unknown>),
  };
}

/**
 * Remove engine-owned wire metadata from the reducer-facing snapshot payload.
 *
 * Snapshot reducers should work with the logical app payload, not the replay
 * bookkeeping fields that wskit can restore automatically later.
 */
export function stripSnapshotMetadata(payload: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(payload)) {
    if (key.startsWith('_')) continue;
    next[key] = value;
  }

  return next;
}

/**
 * Persist one replayable outgoing message.
 *
 * History mode stores every message. Snapshot mode stores one current value
 * per logical key, using the configured reducer when present.
 */
export function persistReplayMessage(
  sql: {
    exec(query: string, ...params: unknown[]): unknown;
    transaction<T>(
      fn: (tx: {
        exec<TRow = unknown>(
          query: string,
          ...params: unknown[]
        ): {
          one(): TRow | null;
        };
      }) => T,
    ): T;
  },
  options: ReplayOptions,
  event: string,
  payload: Record<string, unknown>,
  now: number,
): ReplayRow | null {
  const row = buildReplayRow(options, event, payload, now);

  if ((options.type ?? 'history') === 'history') {
    storeReplayRow(sql, row);
    return row;
  }

  return sql.transaction((tx) => {
    const previousRow = getReplayRowByKey(tx, row.rowKey);
    const nextValue: ReplaySnapshotValue = {
      event,
      payload: stripSnapshotMetadata(payload),
    };
    const reduced = options.reduce
      ? options.reduce(previousRow ? toReplaySnapshotValue(previousRow) : null, nextValue)
      : nextValue;

    if (!reduced) {
      deleteReplayRow(tx, row.rowKey);
      return null;
    }

    const snapshotRow: ReplayRow = {
      ...row,
      event: reduced.event,
      payload: JSON.stringify(reduced.payload),
    };

    storeReplayRow(tx, snapshotRow);
    return snapshotRow;
  });
}

function buildReplayRowKey(
  type: ReplayType,
  scope: ReplayPayloadScope,
  messageId: string,
  snapshotKey: string | null,
): string {
  if (type === 'history') return messageId;

  return [
    'snapshot',
    scope.namespace ?? '',
    scope.channel ?? '',
    scope.channelScope ?? '',
    snapshotKey ?? messageId,
  ].join('|');
}

/**
 * Insert or replace one replay row.
 */
export function storeReplayRow(
  sql: {
    exec(query: string, ...params: unknown[]): unknown;
  },
  row: ReplayRow,
): void {
  sql.exec(
    `
      INSERT OR REPLACE INTO _wskit_replay (
        rowKey,
        messageId,
        seq,
        event,
        payload,
        namespace,
        channel,
        channelScope,
        snapshotKey,
        createdAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    row.rowKey,
    row.messageId,
    row.seq,
    row.event,
    row.payload,
    row.namespace,
    row.channel,
    row.channelScope,
    row.snapshotKey,
    row.createdAt,
  );
}

/**
 * Delete all replay rows older than the configured max age.
 */
export function pruneExpiredReplayRows(
  sql: {
    exec(query: string, ...params: unknown[]): unknown;
  },
  retention: ReplayOptions['retention'] | undefined,
  now: number,
): void {
  if (!retention?.maxAgeMs) return;

  sql.exec(
    `
      DELETE FROM _wskit_replay
      WHERE createdAt < ?
    `,
    now - retention.maxAgeMs,
  );
}

/**
 * Trim one replay scope down to the configured maximum row count.
 */
export function pruneReplayScopeRows(
  sql: {
    exec(query: string, ...params: unknown[]): unknown;
  },
  retention: ReplayOptions['retention'] | undefined,
  scope: ReplayPayloadScope,
): void {
  if (!retention?.maxMessages) return;

  sql.exec(
    `
      DELETE FROM _wskit_replay
      WHERE rowKey IN (
        SELECT rowKey
        FROM _wskit_replay
        WHERE namespace IS ?
          AND channel IS ?
          AND channelScope IS ?
        ORDER BY seq DESC
        LIMIT -1 OFFSET ?
      )
    `,
    scope.namespace,
    scope.channel,
    scope.channelScope,
    retention.maxMessages,
  );
}

/**
 * Load replay rows for the active scope after the client's last seen seq.
 */
/**
 * Build the SQL string and bound params for one `loadReplayRows` call.
 * Branches based on whether the scope targets a specific channel/family or the
 * unscoped top-level replay log.
 */
export function buildLoadReplayQuery(
  since: number,
  scope: { channelName?: string; channelScope: string | null },
): { sql: string; params: unknown[] } {
  if (scope.channelName) {
    if (scope.channelScope === null) {
      // Static channel: scope marker is explicit null, never guessed from
      // value equality with the channel name.
      return {
        sql: `
          SELECT
            rowKey,
            messageId,
            seq,
            event,
            payload,
            namespace,
            channel,
            channelScope,
            snapshotKey,
            createdAt
          FROM _wskit_replay
          WHERE channel IS ?
            AND channelScope IS NULL
            AND seq > ?
          ORDER BY seq ASC
        `,
        params: [scope.channelName, since],
      };
    }
    return {
      sql: `
        SELECT
          rowKey,
          messageId,
          seq,
          event,
          payload,
          namespace,
          channel,
          channelScope,
          snapshotKey,
          createdAt
        FROM _wskit_replay
        WHERE channel IS ?
          AND channelScope IS ?
          AND seq > ?
        ORDER BY seq ASC
      `,
      params: [scope.channelName, scope.channelScope, since],
    };
  }

  return {
    sql: `
      SELECT
        rowKey,
        messageId,
        seq,
        event,
        payload,
        namespace,
        channel,
        channelScope,
        snapshotKey,
        createdAt
      FROM _wskit_replay
      WHERE namespace IS NULL
        AND channel IS NULL
        AND channelScope IS NULL
        AND seq > ?
      ORDER BY seq ASC
    `,
    params: [since],
  };
}

export function loadReplayRows(
  sql: {
    exec<TRow = unknown>(query: string, ...params: unknown[]): { toArray(): TRow[] };
  },
  since: number,
  scope: { channelName?: string; channelScope: string | null },
): ReplayRow[] {
  const query = buildLoadReplayQuery(since, scope);
  const rows = sql.exec<ReplayRow>(query.sql, ...query.params);

  return rows.toArray().map((row) => ({
    rowKey: String(row.rowKey),
    messageId: String(row.messageId),
    seq: Number(row.seq),
    event: String(row.event),
    payload: String(row.payload),
    namespace: (row.namespace as string | null) ?? null,
    channel: (row.channel as string | null) ?? null,
    channelScope: (row.channelScope as string | null) ?? null,
    snapshotKey: (row.snapshotKey as string | null) ?? null,
    createdAt: Number(row.createdAt),
  }));
}
