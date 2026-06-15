import { ENGINE_SCOPE_META } from '~/_engine/contexts/types.ts';
import * as Protocol from '~/_engine/runtime/protocol.ts';
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
    channel TEXT,
    channelScope TEXT,
    snapshotKey TEXT,
    createdAt INTEGER NOT NULL,
    -- Reserved JSON blob: lets us add per-row fields later without a migration.
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

const EMPTY_CLAIMED_CHANNEL_KEYS: ReadonlySet<string> = new Set();

/**
 * The shared rule deciding whether a (channelScope, channelName) pair belongs
 * to a replay instance. A channel-scoped instance (`channelKey` set) takes only
 * its own scope; a server-level instance cascades, taking every scope except
 * the channels another instance has claimed. Both `matchesReplayScope` (context
 * scope) and `shouldStoreReplayMessage` (wire scope) read from this one place so
 * the cascade rule can't drift between the read and write paths.
 */
function scopeMatchesReplayInstance(
  channelKey: string | undefined,
  scope: { channelScope?: string | null; channelName?: string | null },
  claimedChannelKeys: ReadonlySet<string>,
): boolean {
  const { channelScope, channelName } = scope;
  if (channelKey) {
    return channelScope === channelKey || channelName === channelKey;
  }
  if (channelScope && claimedChannelKeys.has(channelScope)) return false;
  if (channelName && claimedChannelKeys.has(channelName)) return false;
  return true;
}

/**
 * Decide whether one replay primitive instance owns the current scope.
 *
 * Channel replay handles only its own concrete channel or channel-family key.
 * Server-level (top-level) replay handles every scope EXCEPT those claimed by
 * another replay primitive — channels that set their own `replay: true` or
 * opted out via `replay: false`. That cascade lets the top-level replay STORE
 * messages from every unclaimed channel.
 *
 * Storing is not the same as serving: a channel-scoped replay request still
 * goes through the channel membership check (`isChannelReplayAuthorized`), so a
 * non-member never gets a channel's history back even though the top-level
 * store holds it. The cascade only decides which replay instance owns the
 * stored rows, not who is allowed to read them.
 *
 */
export function matchesReplayScope(
  channelKey: string | undefined,
  scope: { channelName?: string; channelScope?: string | null },
  claimedChannelKeys: ReadonlySet<string> = EMPTY_CLAIMED_CHANNEL_KEYS,
): boolean {
  return scopeMatchesReplayInstance(channelKey, scope, claimedChannelKeys);
}

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
  // Protocol/control frames (presence, subscribe-ok, errors, …) are bookkeeping,
  // not user messages — they carry no sequence number, so storing them throws.
  // They're re-derived on reconnect (e.g. __memberSync__), so never record them.
  if (Protocol.isProtocolEventName(event)) return false;
  if (typeof wskit.correlationId === 'string') return false;
  if (typeof wskit.streamId === 'string') return false;

  const scope = readReplayScope(wskit);
  return scopeMatchesReplayInstance(
    channelKey,
    { channelScope: scope.channelScope, channelName: scope.channel },
    claimedChannelKeys,
  );
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
    throw new Error('[wskit] replay requires `sequence` and `dedup` enabled in the same scope.');
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

  /**
   * Validate the value a `reduce` produced against the public contract before
   * it is stored. Only the reducer can introduce a shape the live send didn't
   * already check, so this runs solely on reduced values. It should throw if
   * the event/payload doesn't conform — keeping the replay-from-storage path
   * trusted. Not called when no `reduce` is configured.
   */
  validateReduced?: (event: string, payload: Record<string, unknown>) => void;
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
  const { options, event, payload, wskit, now, scope, postFlush, validateReduced } = opts;
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

    let previousValue: ReplaySnapshotValue | null;
    if (queued !== undefined) {
      previousValue = queued.row === null ? null : toReplaySnapshotValue(queued.row);
    } else {
      const fromDisk = sql.transaction((tx) => getReplayRowByKey(tx, row.rowKey));
      previousValue = fromDisk ? toReplaySnapshotValue(fromDisk) : null;
    }

    const reduced = options.reduce ? options.reduce(previousValue, nextValue) : nextValue;

    if (!reduced) {
      scope.pendingReplaySnapshotRows.set(row.rowKey, {
        row: null,
        postFlush: postFlush ?? noopPostFlush,
      });
      return null;
    }

    if (options.reduce) validateReduced?.(reduced.event, reduced.payload);

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

    if (options.reduce) validateReduced?.(reduced.event, reduced.payload);

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

  return JSON.stringify([
    'snapshot',
    scope.channel ?? '',
    scope.channelScope ?? '',
    snapshotKey ?? messageId,
  ]);
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
        channel,
        channelScope,
        snapshotKey,
        createdAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    row.rowKey,
    row.messageId,
    row.seq,
    row.event,
    row.payload,
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
 * Trim one replay store down to the configured maximum row count.
 *
 * Replay has exactly two replay stores: the top-level one and one per channel.
 * The limit is matched to the read by keying on `channel`/`channelScope`:
 *
 * - Top-level store (`channel` is null): keep the newest N across every
 *   non-channel row.
 * - Channel store: keep the newest N for that one `(channel, channelScope)`.
 *
 * Both cases fall out of the same query: a null `channel`/`channelScope` binds
 * to the top-level rows, a real channel binds to that channel's rows. Ordering
 * by `seq` is well-defined because the sequence counter is global (one counter
 * for the whole server).
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
        WHERE channel IS ?
          AND channelScope IS ?
        ORDER BY seq DESC
        LIMIT -1 OFFSET ?
      )
    `,
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
      return {
        sql: `
          SELECT
            rowKey,
            messageId,
            seq,
            event,
            payload,
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

  // Top-level replay returns every non-channel row. There are only two replay
  // stores, top-level and per-channel. The limit in `pruneReplayScopeRows`
  // matches this read (it counts the whole top-level store as one), so
  // `maxMessages` bounds what this read returns.
  return {
    sql: `
      SELECT
        rowKey,
        messageId,
        seq,
        event,
        payload,
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
    channel: (row.channel as string | null) ?? null,
    channelScope: (row.channelScope as string | null) ?? null,
    snapshotKey: (row.snapshotKey as string | null) ?? null,
    createdAt: Number(row.createdAt),
  }));
}
