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
  CREATE TABLE IF NOT EXISTS __wskit_replay (
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
  CREATE INDEX IF NOT EXISTS __wskit_idx_replay_seq
  ON __wskit_replay (seq)
`;

const CREATE_REPLAY_SCOPE_SEQ_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS __wskit_idx_replay_scope_seq
  ON __wskit_replay (channel, channelScope, seq)
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
 * replay primitive — channels that set their own `replay: true` or opted out
 * via `replay: false`. That cascade behavior lets the top-level replay capture
 * and serve every unclaimed channel.
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
  wskit: { channelScope?: string | null } | undefined,
): boolean {
  if (!scope.channelName) return true;
  if (!connection) return false;
  return ChannelPrimitive.hasChannelMembership(
    connection,
    scope.channelName,
    wskit?.channelScope ?? null,
  );
}

/**
 * Read the hidden scope markers attached to one live connection ctx.
 */
export function readReplayContextScope(ctx: Record<PropertyKey, unknown>): EngineScopeMeta {
  return (ctx[ENGINE_SCOPE_META] as EngineScopeMeta | undefined) ?? {};
}

/**
 * Read replay scope markers from one outgoing frame's `__wskit` block.
 */
export function readReplayScope(wskit: Record<string, unknown>): ReplayPayloadScope {
  return {
    namespace: typeof wskit.namespace === 'string' ? wskit.namespace : null,
    channel: typeof wskit.channel === 'string' ? wskit.channel : null,
    channelScope: typeof wskit.channelScope === 'string' ? wskit.channelScope : null,
  };
}

/**
 * Reject a `__replay__` request whose namespace lands on a top-level replay
 * primitive that does not own namespace traffic.
 *
 * Namespace-scoped replay is not implemented yet (issue #8 tracks that work).
 * Without this guard, a top-level `__replay__` carrying a namespace reads the
 * unscoped store under `WHERE namespace IS NULL`, returning either zero rows
 * or — worse — top-level rows to a client that expected namespace history.
 */
export function assertReplayScopeServable(
  channelKey: string | undefined,
  scope: { namespaceName?: string },
): void {
  if (!channelKey && scope.namespaceName) {
    throw ValidationFailed({
      event: '__replay__',
      issues: [
        {
          message: `replay is not configured for namespace "${scope.namespaceName}"`,
          path: ['namespace'],
        },
      ],
    });
  }
}

/**
 * Decide whether one outgoing frame belongs to this replay instance.
 *
 * Channel-scoped replay only stores frames for its own channel. Server-level
 * replay (no `channelKey`) cascades — it stores frames for every scope except
 * the channels listed in `claimedChannelKeys`.
 *
 * Frames carrying a `correlationId` are private 1:1 request responses, and
 * frames carrying a `streamId` are stream chunks — neither belongs in a replay
 * store, so both are skipped.
 */
export function shouldStoreReplayMessage(
  channelKey: string | undefined,
  event: string,
  wskit: Record<string, unknown>,
  exclude: ReadonlySet<string>,
  claimedChannelKeys: ReadonlySet<string> = EMPTY_CLAIMED_CHANNEL_KEYS,
): boolean {
  if (exclude.has(event)) return false;
  if (typeof wskit.correlationId === 'string') return false;
  if (typeof wskit.streamId === 'string') return false;

  const scope = readReplayScope(wskit);

  if (channelKey) {
    return scope.channelScope === channelKey || scope.channel === channelKey;
  }

  if (scope.channelScope && claimedChannelKeys.has(scope.channelScope)) return false;
  if (scope.channel && claimedChannelKeys.has(scope.channel)) return false;
  return true;
}

/**
 * Convert one outgoing frame into the replay row that should be stored. The
 * `payload` column holds the pure user payload; sequence number, message id,
 * and scope come from the frame's `__wskit`.
 */
export function buildReplayRow(
  options: ReplayOptions,
  event: string,
  payload: Record<string, unknown>,
  wskit: Record<string, unknown>,
  now: number,
): ReplayRow {
  const seq = wskit.seq;
  const messageId = wskit.messageId;

  if (typeof seq !== 'number' || typeof messageId !== 'string') {
    throw new Error('[wskit] replay() requires sequence() and dedup() in the same scope.');
  }

  const scope = readReplayScope(wskit);
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
        FROM __wskit_replay
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
 */
export function deleteReplayRow(
  sql: {
    exec(query: string, ...params: unknown[]): unknown;
  },
  rowKey: string,
): void {
  sql.exec(
    `
      DELETE FROM __wskit_replay
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
    payload: JSON.parse(row.payload) as Record<string, unknown>,
  };
}

/**
 * Persist one replayable outgoing frame.
 *
 * History mode stores every frame. Snapshot mode stores one current value per
 * logical key, using the configured reducer when present.
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
  wskit: Record<string, unknown>,
  now: number,
): ReplayRow | null {
  const row = buildReplayRow(options, event, payload, wskit, now);

  if ((options.type ?? 'history') === 'history') {
    storeReplayRow(sql, row);
    return row;
  }

  return sql.transaction((tx) => {
    const previousRow = getReplayRowByKey(tx, row.rowKey);
    const nextValue: ReplaySnapshotValue = { event, payload };
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
      INSERT OR REPLACE INTO __wskit_replay (
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
      DELETE FROM __wskit_replay
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
      DELETE FROM __wskit_replay
      WHERE rowKey IN (
        SELECT rowKey
        FROM __wskit_replay
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
 * Build the SQL string and bound params for one `loadReplayRows` call.
 */
export function buildLoadReplayQuery(
  since: number,
  scope: { channelName?: string; channelScope: string | null },
): { sql: string; params: unknown[] } {
  if (scope.channelName) {
    if (scope.channelScope === null) {
      // Static channel: scope marker is always an explicit null.
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
          FROM __wskit_replay
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
        FROM __wskit_replay
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
      FROM __wskit_replay
      WHERE namespace IS NULL
        AND channel IS NULL
        AND channelScope IS NULL
        AND seq > ?
      ORDER BY seq ASC
    `,
    params: [since],
  };
}

/**
 * Load replay rows for the active scope after the client's last seen seq.
 */
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
