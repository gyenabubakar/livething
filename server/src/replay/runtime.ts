import { ENGINE_SCOPE_META } from '~/_engine/contexts/types.ts';
import * as ChannelPrimitive from '~/channel/runtime.ts';
import type { EngineScopeMeta } from '~/_engine/contexts/types.ts';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';
import type { SQLProvider } from '~/context.ts';
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
    createdAt INTEGER NOT NULL,
    metadata TEXT NOT NULL DEFAULT '{}'
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

const REPLAY_SCHEMA_SQL = [
  CREATE_REPLAY_TABLE_SQL,
  CREATE_REPLAY_SEQ_INDEX_SQL,
  CREATE_REPLAY_SCOPE_SEQ_INDEX_SQL,
].join(';\n');

/**
 * Create the SQLite tables and indexes the automatic replay primitive needs.
 * One round trip instead of three thanks to multi-statement `sql.exec`.
 */
export function ensureReplaySchema(sql: {
  exec(query: string, ...params: unknown[]): unknown;
}): void {
  sql.exec(REPLAY_SCHEMA_SQL);
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
export interface ShouldStoreReplayMessageOptions {
  channelKey: string | undefined;

  wskit: Record<string, unknown>;

  exclude: ReadonlySet<string>;

  claimedChannelKeys?: ReadonlySet<string>;
}

export function shouldStoreReplayMessage(
  event: string,
  options: ShouldStoreReplayMessageOptions,
): boolean {
  const { channelKey, wskit, exclude, claimedChannelKeys = EMPTY_CLAIMED_CHANNEL_KEYS } = options;
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
export interface BuildReplayRowOptions {
  options: ReplayOptions;

  payload: Record<string, unknown>;

  wskit: Record<string, unknown>;

  now: number;
}

export function buildReplayRow(event: string, params: BuildReplayRowOptions): ReplayRow {
  const { options, payload, wskit, now } = params;
  const seq = wskit.seq;
  const messageId = wskit.messageId;

  if (typeof seq !== 'number' || typeof messageId !== 'string') {
    throw new Error('[wskit] replay() requires sequence() and dedup() in the same scope.');
  }

  const scope = readReplayScope(wskit);
  const type = options.type ?? 'history';
  const snapshotKey = type === 'snapshot' ? (options.snapshotKey?.(event, payload) ?? event) : null;

  return {
    rowKey: buildReplayRowKey(type, scope, { messageId, snapshotKey }),
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

export interface PersistReplayMessageOptions {
  options: ReplayOptions;

  event: string;

  payload: Record<string, unknown>;

  wskit: Record<string, unknown>;

  now: number;

  /**
   * The engine's open invocation scope, if a handler is currently running.
   * When this is set AND the replay mode is `snapshot`, this function does
   * NOT write to SQL. Instead, it adds the row to
   * `scope.pendingReplaySnapshotRows` under the row key the snapshot maps
   * to. A later write in the same handler that targets the same key will
   * find the queued row and either replace it with the new value, or run
   * the reducer to merge the two — all in memory. When the handler
   * finishes, the engine walks the queue and writes one row per unique key.
   *
   * Pass `null` (or leave it out) to keep the old behaviour where each call
   * writes to SQL right away.
   */
  scope?: {
    pendingReplaySnapshotRows: Map<
      string,
      {
        row: ReplayRow | null;
        postFlush: (sql: Pick<SQLProvider, 'exec'>) => void;
      }
    >;
  } | null;

  /**
   * Clean-up callback that runs RIGHT AFTER the row is written to SQL.
   * Replay uses this to run its retention prune (drop oldest rows when the
   * total goes over the limit, drop rows that have expired). Running the
   * prune before the row is on disk would miss the just-written row when
   * counting, so the scope flusher saves the row first and only then calls
   * this callback.
   */
  postFlush?: (sql: Pick<SQLProvider, 'exec'>) => void;
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
  opts: PersistReplayMessageOptions,
): ReplayRow | null {
  const { options, event, payload, wskit, now, scope, postFlush } = opts;
  function noopPostFlush(): void {}

  const row = buildReplayRow(event, { options, payload, wskit, now });

  if ((options.type ?? 'history') === 'history') {
    storeReplayRow(sql, row);
    return row;
  }

  // Snapshot mode AND the engine has a handler scope open. Don't write to
  // SQL yet. Take the previous value for this row key — from the queue if
  // an earlier write in this same handler already touched the key,
  // otherwise from disk — run the user's reducer over (previous, next),
  // and save the result back into the queue. The scope flusher will walk
  // the queue at the end of the handler and write one row per key (or
  // delete the key when the reducer returned `null`).
  if (scope) {
    const nextValue: ReplaySnapshotValue = { event, payload };
    const queued = scope.pendingReplaySnapshotRows.get(row.rowKey);

    const previousValue =
      queued !== undefined
        ? queued.row === null
          ? null
          : toReplaySnapshotValue(queued.row)
        : (() => {
            const fromDisk = sql.transaction((tx) => getReplayRowByKey(tx, row.rowKey));
            return fromDisk ? toReplaySnapshotValue(fromDisk) : null;
          })();

    const reduced = options.reduce ? options.reduce(previousValue, nextValue) : nextValue;

    if (!reduced) {
      scope.pendingReplaySnapshotRows.set(row.rowKey, {
        row: null,
        postFlush: postFlush ?? noopPostFlush,
      });
      return null;
    }

    const snapshotRow: ReplayRow = {
      ...row,
      event: reduced.event,
      payload: JSON.stringify(reduced.payload),
    };

    scope.pendingReplaySnapshotRows.set(row.rowKey, {
      row: snapshotRow,
      postFlush: postFlush ?? noopPostFlush,
    });

    return snapshotRow;
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
  ids: { messageId: string; snapshotKey: string | null },
): string {
  const { messageId, snapshotKey } = ids;
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
  if (retention?.maxAgeMs === undefined) return;

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
  if (retention?.maxMessages === undefined) return;

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

  // Top-level replay returns every non-channel row regardless of namespace.
  // Namespace messages come back here too; each row still carries its
  // namespace so the client routes it to the right handler.
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
      WHERE channel IS NULL
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
