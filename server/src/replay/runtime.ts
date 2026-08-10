import { ENGINE_CHANNEL_META } from '~/_engine/contexts/contexts.ts';
import * as Protocol from '~/_engine/runtime/protocol.ts';
import * as ChannelPrimitive from '~/channel/runtime.ts';
import type { EngineChannelMeta } from '~/_engine/contexts/types.ts';
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
    channelFamily TEXT,
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
  ON __wskit_replay (channel, channelFamily, seq)
`;

const CREATE_REPLAY_WATERMARK_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS __wskit_replay_watermark (
    scope_key TEXT PRIMARY KEY,
    evicted_through_seq INTEGER NOT NULL,
    -- Reserved JSON blob: lets us add per-scope fields later without a migration.
    metadata TEXT NOT NULL DEFAULT '{}'
  )
`;

const REPLAY_SCHEMA_SQL = [
  CREATE_REPLAY_TABLE_SQL,
  CREATE_REPLAY_SEQ_INDEX_SQL,
  CREATE_REPLAY_SCOPE_SEQ_INDEX_SQL,
  CREATE_REPLAY_WATERMARK_TABLE_SQL,
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
 * The `scope_key` primary key for the eviction watermark table. The top-level
 * store is `''`; a channel scope mirrors the membership-key convention
 * (`JSON.stringify([channelFamily, channel])`) so both stay in step. A channel
 * row always has a concrete `channel`, so a present `channel` marks a channel
 * scope even when `channelFamily` is null (a static channel).
 */
export function replayScopeKey(scope: {
  channel: string | null;
  channelFamily: string | null;
}): string {
  if (scope.channel === null) return '';
  return JSON.stringify([scope.channelFamily, scope.channel]);
}

/**
 * The shared rule deciding whether a (channelFamily, channelName) pair belongs
 * to a replay instance. A channel-scoped instance (`channelKey` set) takes only
 * its own scope; a server-level instance cascades, taking every scope except
 * the channels another instance has claimed. Both `matchesReplayScope` (context
 * scope) and `shouldStoreReplayMessage` (wire scope) read from this one place so
 * the cascade rule can't drift between the read and write paths.
 */
function scopeMatchesReplayInstance(
  channelKey: string | undefined,
  scope: { channelFamily?: string | null; channelName?: string | null },
  claimedChannelKeys: ReadonlySet<string>,
): boolean {
  const { channelFamily, channelName } = scope;
  if (channelKey) {
    return channelFamily === channelKey || channelName === channelKey;
  }
  if (channelFamily && claimedChannelKeys.has(channelFamily)) return false;
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
  scope: { channelName?: string; channelFamily?: string | null },
  claimedChannelKeys: ReadonlySet<string> = EMPTY_CLAIMED_CHANNEL_KEYS,
): boolean {
  return scopeMatchesReplayInstance(channelKey, scope, claimedChannelKeys);
}

/**
 * Check whether a connection may receive replay rows for a channel-scoped
 * request. Non-channel requests pass through. Channel requests require live
 * membership in the same (channelName, channelFamily) the request asks for.
 */
export function isChannelReplayAuthorized(
  connection: RuntimeConnection | undefined,
  scope: { channelName?: string },
  wskit: { channelFamily?: string | null } | undefined,
): boolean {
  if (!scope.channelName) return true;
  if (!connection) return false;
  return ChannelPrimitive.hasChannelMembership(
    connection,
    scope.channelName,
    wskit?.channelFamily ?? null,
  );
}

/**
 * Read the hidden scope markers attached to one live connection ctx.
 */
export function readReplayContextScope(ctx: Record<PropertyKey, unknown>): EngineChannelMeta {
  return (ctx[ENGINE_CHANNEL_META] as EngineChannelMeta | undefined) ?? {};
}

/**
 * Read replay scope markers from one outgoing frame's `__wskit` block.
 */
export function readReplayScope(wskit: Record<string, unknown>): ReplayPayloadScope {
  return {
    channel: typeof wskit.channel === 'string' ? wskit.channel : null,
    channelFamily: typeof wskit.channelFamily === 'string' ? wskit.channelFamily : null,
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
    { channelFamily: scope.channelFamily, channelName: scope.channel },
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
    channelFamily: scope.channelFamily,
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
          channelFamily,
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
    channelFamily: (row.channelFamily as string | null) ?? null,
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
 * One queued snapshot write held in the invocation scope. `row` is the value a
 * later write in the same handler merges against; `flush` writes (or deletes)
 * the row and runs the retention prune. The engine drains the queue by calling
 * `flush`, so it never imports the replay storage helpers.
 */
export interface ReplaySnapshotEntry {
  row: ReplayRow | null;
  flush: (sql: Pick<SQLProvider, 'exec'>) => void;
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
   * `scope.pendingSnapshotFlushes` under the row key the snapshot maps
   * to. A later write in the same handler that targets the same key will
   * find the queued row and either replace it with the new value, or run
   * the reducer to merge the two — all in memory. When the handler
   * finishes, the engine walks the queue and writes one row per unique key.
   *
   * Pass `null` (or leave it out) to have each call write to SQL right away.
   */
  scope?: {
    pendingSnapshotFlushes: Map<string, ReplaySnapshotEntry>;
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
    const queued = scope.pendingSnapshotFlushes.get(row.rowKey);

    let previousValue: ReplaySnapshotValue | null;
    if (queued !== undefined) {
      previousValue = queued.row === null ? null : toReplaySnapshotValue(queued.row);
    } else {
      const fromDisk = sql.transaction((tx) => getReplayRowByKey(tx, row.rowKey));
      previousValue = fromDisk ? toReplaySnapshotValue(fromDisk) : null;
    }

    const reduced = options.reduce ? options.reduce(previousValue, nextValue) : nextValue;
    const prune = postFlush ?? noopPostFlush;

    if (!reduced) {
      scope.pendingSnapshotFlushes.set(row.rowKey, {
        row: null,
        flush: (sqlForFlush) => {
          deleteReplayRow(sqlForFlush, row.rowKey);
          prune(sqlForFlush);
        },
      });
      return null;
    }

    if (options.reduce) validateReduced?.(reduced.event, reduced.payload);

    const snapshotRow: ReplayRow = {
      ...row,
      event: reduced.event,
      payload: JSON.stringify(reduced.payload),
    };

    scope.pendingSnapshotFlushes.set(row.rowKey, {
      row: snapshotRow,
      flush: (sqlForFlush) => {
        storeReplayRow(sqlForFlush, snapshotRow);
        prune(sqlForFlush);
      },
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
    scope.channelFamily ?? '',
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
        channelFamily,
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
    row.channelFamily,
    row.snapshotKey,
    row.createdAt,
  );
}

/**
 * Raise one scope's eviction watermark to at least `evictedThroughSeq`.
 *
 * The upsert is monotonic: an existing watermark is never lowered, so a later
 * prune that happens to delete an older (smaller-seq) tail can't roll back a
 * higher watermark a previous prune already recorded. The watermark is the
 * highest `seq` this scope has actually deleted, which gap detection reads to
 * tell "you missed evicted messages" from "nothing happened".
 */
export function bumpReplayWatermark(
  sql: {
    exec(query: string, ...params: unknown[]): unknown;
  },
  scopeKey: string,
  evictedThroughSeq: number,
): void {
  sql.exec(
    `
      INSERT INTO __wskit_replay_watermark (scope_key, evicted_through_seq)
      VALUES (?, ?)
      ON CONFLICT(scope_key) DO UPDATE SET
        evicted_through_seq = MAX(evicted_through_seq, excluded.evicted_through_seq)
    `,
    scopeKey,
    evictedThroughSeq,
  );
}

/**
 * Read one scope's eviction watermark, or `null` when nothing has been evicted
 * from that scope yet.
 */
export function readReplayWatermark(
  sql: {
    exec<TRow = unknown>(query: string, ...params: unknown[]): { one(): TRow | null };
  },
  scopeKey: string,
): number | null {
  const row = sql
    .exec<{ evicted_through_seq: number }>(
      `
        SELECT evicted_through_seq
        FROM __wskit_replay_watermark
        WHERE scope_key = ?
      `,
      scopeKey,
    )
    .one();

  return row ? Number(row.evicted_through_seq) : null;
}

/** Delete replay rows older than the max age, first recording each scope's highest dropped seq as its watermark. */
export function pruneExpiredReplayRows(
  sql: {
    exec<TRow = unknown>(query: string, ...params: unknown[]): { toArray(): TRow[] };
  },
  retention: ReplayOptions['retention'] | undefined,
  now: number,
): void {
  if (retention?.maxAgeMs === undefined) return;

  const cutoff = now - retention.maxAgeMs;

  const evicted = sql
    .exec<{ channel: string | null; channelFamily: string | null; m: number }>(
      `
        SELECT channel, channelFamily, MAX(seq) AS m
        FROM __wskit_replay
        WHERE createdAt < ?
        GROUP BY channel, channelFamily
      `,
      cutoff,
    )
    .toArray();

  for (const scope of evicted) {
    bumpReplayWatermark(
      sql,
      replayScopeKey({
        channel: (scope.channel as string | null) ?? null,
        channelFamily: (scope.channelFamily as string | null) ?? null,
      }),
      Number(scope.m),
    );
  }

  sql.exec(
    `
      DELETE FROM __wskit_replay
      WHERE createdAt < ?
    `,
    cutoff,
  );
}

/**
 * Trim one replay store down to the configured maximum row count.
 *
 * Replay has exactly two replay stores: the top-level one and one per channel.
 * The limit is matched to the read by keying on `channel`/`channelFamily`:
 *
 * - Top-level store (`channel` is null): keep the newest N across every
 *   non-channel row.
 * - Channel store: keep the newest N for that one `(channel, channelFamily)`.
 *
 * Both cases fall out of the same query: a null `channel`/`channelFamily` binds
 * to the top-level rows, a real channel binds to that channel's rows. Ordering
 * by `seq` is well-defined because the sequence counter is global (one counter
 * for the whole server).
 */
export function pruneReplayScopeRows(
  sql: {
    exec<TRow = unknown>(query: string, ...params: unknown[]): { one(): TRow | null };
  },
  retention: ReplayOptions['retention'] | undefined,
  scope: ReplayPayloadScope,
): void {
  if (retention?.maxMessages === undefined) return;

  const dropped = sql
    .exec<{ m: number | null }>(
      `
        SELECT MAX(seq) AS m
        FROM (
          SELECT seq
          FROM __wskit_replay
          WHERE channel IS ?
            AND channelFamily IS ?
          ORDER BY seq DESC
          LIMIT -1 OFFSET ?
        )
      `,
      scope.channel,
      scope.channelFamily,
      retention.maxMessages,
    )
    .one();

  if (dropped?.m != null) {
    bumpReplayWatermark(sql, replayScopeKey(scope), Number(dropped.m));
  }

  sql.exec(
    `
      DELETE FROM __wskit_replay
      WHERE rowKey IN (
        SELECT rowKey
        FROM __wskit_replay
        WHERE channel IS ?
          AND channelFamily IS ?
        ORDER BY seq DESC
        LIMIT -1 OFFSET ?
      )
    `,
    scope.channel,
    scope.channelFamily,
    retention.maxMessages,
  );
}

/** Count the rows in one replay store (top-level or a single channel). */
export function countReplayScopeRows(
  sql: { exec<TRow = unknown>(query: string, ...params: unknown[]): { one(): TRow | null } },
  scope: ReplayPayloadScope,
): number {
  const row = sql
    .exec<{
      n: number;
    }>(
      `SELECT COUNT(*) AS n FROM __wskit_replay WHERE channel IS ? AND channelFamily IS ?`,
      scope.channel,
      scope.channelFamily,
    )
    .one();
  return row ? Number(row.n) : 0;
}

/** The oldest `createdAt` across the whole replay table, or null when empty. */
export function minReplayCreatedAt(sql: {
  exec<TRow = unknown>(query: string, ...params: unknown[]): { one(): TRow | null };
}): number | null {
  const row = sql
    .exec<{ m: number | null }>(`SELECT MIN(createdAt) AS m FROM __wskit_replay`)
    .one();
  return row?.m == null ? null : Number(row.m);
}

/**
 * Runs the per-message retention prune only when it would actually evict — an
 * in-memory row count and oldest-timestamp prove when the store is under its
 * caps, where the prune only scans and deletes nothing. Both are seeded from the
 * table on first use, so a hibernation wake stays correct, then maintained as
 * history rows are stored. Skipping an under-cap prune is exactly what the prune
 * itself would have done, so eviction and the gap watermark are unchanged.
 */
export class ReplayPruneGate {
  private minCreatedAt: number | null = null;
  private minSeeded = false;
  private readonly scopeCounts = new Map<string, number>();

  prune(
    sql: Pick<SQLProvider, 'exec'>,
    opts: {
      retention: ReplayOptions['retention'] | undefined;
      scope: ReplayPayloadScope;
      stamp: number;
    },
  ): void {
    const { retention, scope, stamp } = opts;
    if (retention?.maxAgeMs !== undefined) {
      if (!this.minSeeded) {
        this.minCreatedAt = minReplayCreatedAt(sql);
        this.minSeeded = true;
      } else if (this.minCreatedAt === null || stamp < this.minCreatedAt) {
        this.minCreatedAt = stamp;
      }
      if (this.minCreatedAt !== null && this.minCreatedAt < stamp - retention.maxAgeMs) {
        pruneExpiredReplayRows(sql, retention, stamp);
        this.minCreatedAt = minReplayCreatedAt(sql);
      }
    }

    if (retention?.maxMessages !== undefined) {
      const key = replayScopeKey(scope);
      const cached = this.scopeCounts.get(key);
      const count = cached === undefined ? countReplayScopeRows(sql, scope) : cached + 1;
      if (count > retention.maxMessages) {
        pruneReplayScopeRows(sql, retention, scope);
        this.scopeCounts.set(key, retention.maxMessages);
      } else {
        this.scopeCounts.set(key, count);
      }
    }
  }
}

/**
 * Build the SQL string and bound params for one `loadReplayRows` call.
 */
export function buildLoadReplayQuery(
  since: number,
  scope: { channelName?: string; channelFamily: string | null },
): { sql: string; params: unknown[] } {
  if (scope.channelName) {
    if (scope.channelFamily === null) {
      return {
        sql: `
          SELECT
            rowKey,
            messageId,
            seq,
            event,
            payload,
            channel,
            channelFamily,
            snapshotKey,
            createdAt
          FROM __wskit_replay
          WHERE channel IS ?
            AND channelFamily IS NULL
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
          channelFamily,
          snapshotKey,
          createdAt
        FROM __wskit_replay
        WHERE channel IS ?
          AND channelFamily IS ?
          AND seq > ?
        ORDER BY seq ASC
      `,
      params: [scope.channelName, scope.channelFamily, since],
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
        channelFamily,
        snapshotKey,
        createdAt
      FROM __wskit_replay
      WHERE channel IS NULL
        AND channelFamily IS NULL
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
  scope: { channelName?: string; channelFamily: string | null },
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
    channelFamily: (row.channelFamily as string | null) ?? null,
    snapshotKey: (row.snapshotKey as string | null) ?? null,
    createdAt: Number(row.createdAt),
  }));
}
