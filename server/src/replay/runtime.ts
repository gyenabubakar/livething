import { ENGINE_CHANNEL_META } from '~/_engine/contexts/contexts.ts';
import { serializePayload } from '~/_engine/runtime/json-guard.ts';
import * as Protocol from '~/_engine/runtime/protocol.ts';
import { chunkForBind } from '~/_engine/sql-batch.ts';
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
  CREATE TABLE IF NOT EXISTS __livething_replay (
    rowKey TEXT PRIMARY KEY,
    messageId TEXT NOT NULL,
    seq INTEGER NOT NULL,
    event TEXT NOT NULL,
    payload TEXT NOT NULL,
    channel TEXT,
    channelFamily TEXT,
    -- The one user the frame was addressed to, or NULL when it went to everyone in its scope.
    userId TEXT,
    -- JSON array of the resume tokens of the connections the frame was sent to, or NULL.
    recipients TEXT,
    -- The retention budget and gap watermark the row counts toward (see replayAudienceOf).
    audience TEXT NOT NULL DEFAULT '',
    snapshotKey TEXT,
    createdAt INTEGER NOT NULL,
    -- Reserved JSON blob: lets us add per-row fields later without a migration.
    metadata TEXT NOT NULL DEFAULT '{}'
  )
`;

const CREATE_REPLAY_SEQ_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS __livething_idx_replay_seq
  ON __livething_replay (seq)
`;

const CREATE_REPLAY_SCOPE_SEQ_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS __livething_idx_replay_scope_seq
  ON __livething_replay (channel, channelFamily, seq)
`;

const CREATE_REPLAY_AUDIENCE_SEQ_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS __livething_idx_replay_audience_seq
  ON __livething_replay (channel, channelFamily, audience, seq)
`;

const CREATE_REPLAY_WATERMARK_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS __livething_replay_watermark (
    scope_key TEXT PRIMARY KEY,
    evicted_through_seq INTEGER NOT NULL,
    -- Reserved JSON blob: lets us add per-scope fields later without a migration.
    metadata TEXT NOT NULL DEFAULT '{}'
  )
`;

// @__PURE__ lets the bundler drop this when unused; see channel/storage.ts.
const REPLAY_SCHEMA_SQL = /* @__PURE__ */ [
  CREATE_REPLAY_TABLE_SQL,
  CREATE_REPLAY_SEQ_INDEX_SQL,
  CREATE_REPLAY_SCOPE_SEQ_INDEX_SQL,
  CREATE_REPLAY_AUDIENCE_SEQ_INDEX_SQL,
  CREATE_REPLAY_WATERMARK_TABLE_SQL,
].join(';\n');

const REPLAY_ROW_COLUMNS = `
  rowKey,
  messageId,
  seq,
  event,
  payload,
  channel,
  channelFamily,
  userId,
  recipients,
  snapshotKey,
  createdAt
`;

interface ReplayStorageScope {
  channel: string | null;
  channelFamily: string | null;
}

interface ReplayScopeMatch {
  channelFamily?: string | null;
  channelName?: string | null;
}

interface ReplayRequestScope {
  channelName?: string;
  channelFamily?: string | null;
}

interface ReplayLoadScope {
  channelName?: string;
  channelFamily: string | null;
  /**
   * The requesting connection's user id, or `null` for an anonymous
   * connection. Rows addressed to one user load only for that user.
   */
  userId: string | null;
  /**
   * The resume tokens the requester showed. A row sent to chosen connections
   * loads only when it lists one of them and has the requester's user.
   */
  resumeTokens?: readonly string[];
}

/**
 * Which rows one replay instance owns, so its retention never touches another
 * instance's store. A channel-scoped instance (`channelKey` set) owns only its
 * own channel's rows; the server-level instance owns every row except the
 * channels in `claimedChannelKeys`. Mirrors `scopeMatchesReplayInstance`.
 */
export interface ReplayStoreOwner {
  channelKey: string | undefined;
  claimedChannelKeys: ReadonlySet<string>;
}

interface ReplayEnvelopeScope {
  channelFamily?: string | null;
}

interface ReplayRowKeyIds {
  messageId: string;
  snapshotKey: string | null;
  userId: string | null;
  recipients: string | null;
}

interface ReplayPruneOptions {
  retention: ReplayOptions['retention'] | undefined;
  scope: ReplayAudienceScope;
  owner: ReplayStoreOwner;
  stamp: number;
}

/**
 * Create the SQLite tables and indexes the automatic replay primitive needs.
 * One round trip instead of three thanks to multi-statement `sql.exec`.
 */
export function ensureReplaySchema(sql: Pick<SQLProvider, 'exec'>): void {
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
export function replayScopeKey(scope: ReplayStorageScope): string {
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
  scope: ReplayScopeMatch,
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
  scope: ReplayRequestScope,
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
  scope: Pick<ReplayRequestScope, 'channelName'>,
  livething: ReplayEnvelopeScope | undefined,
): boolean {
  if (!scope.channelName) return true;

  if (!connection) return false;

  return ChannelPrimitive.hasChannelMembership(
    connection,
    scope.channelName,
    livething?.channelFamily ?? null,
  );
}

/**
 * Read the hidden scope markers attached to one live connection ctx.
 */
export function readReplayContextScope(ctx: Record<PropertyKey, unknown>): EngineChannelMeta {
  return (ctx[ENGINE_CHANNEL_META] as EngineChannelMeta | undefined) ?? {};
}

/**
 * Read replay scope markers from one outgoing frame's `__livething` block.
 */
export function readReplayScope(livething: Record<string, unknown>): ReplayPayloadScope {
  return {
    channel: typeof livething.channel === 'string' ? livething.channel : null,
    channelFamily: typeof livething.channelFamily === 'string' ? livething.channelFamily : null,
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

  livething: Record<string, unknown>;

  exclude: ReadonlySet<string>;

  claimedChannelKeys?: ReadonlySet<string>;
}

export function shouldStoreReplayMessage(
  event: string,
  options: ShouldStoreReplayMessageOptions,
): boolean {
  const {
    channelKey,
    livething,
    exclude,
    claimedChannelKeys = EMPTY_CLAIMED_CHANNEL_KEYS,
  } = options;
  if (exclude.has(event)) return false;

  // Protocol/control frames (presence, subscribe-ok, errors, …) are bookkeeping,
  // not user messages — they carry no sequence number, so storing them throws.
  // They're re-derived on reconnect (e.g. __memberSync__), so never record them.
  if (Protocol.isProtocolEventName(event)) return false;

  if (typeof livething.correlationId === 'string') return false;

  if (typeof livething.streamId === 'string') return false;

  const scope = readReplayScope(livething);

  return scopeMatchesReplayInstance(
    channelKey,
    { channelFamily: scope.channelFamily, channelName: scope.channel },
    claimedChannelKeys,
  );
}

/** The audience of the shared log: frames sent to everyone in a scope. */
const SHARED_AUDIENCE = '';
/** The one audience all frames sent to chosen anonymous connections share. */
const ANONYMOUS_AUDIENCE = 'anonymous';

/**
 * The retention budget and gap watermark a row counts toward: the shared log,
 * one user's rows (sent to that user, or to chosen connections of theirs), or
 * the rows sent to chosen anonymous connections. Each has its own `maxMessages`
 * and its own watermark, so one audience's rows never push out another's or
 * report a gap to a client that never had them. Anonymous connections share one
 * audience: they have no identity to keep apart, and one per connection would
 * grow without limit.
 */
export function replayAudienceOf(userId: string | null, toChosenConnections: boolean): string {
  if (userId) return `user:${userId}`;

  return toChosenConnections ? ANONYMOUS_AUDIENCE : SHARED_AUDIENCE;
}

/**
 * Convert one outgoing frame into the replay row that should be stored. The
 * `payload` column holds the pure user payload; sequence number, message id,
 * and scope come from the frame's `__livething`.
 */
export interface BuildReplayRowOptions {
  options: ReplayOptions;

  payload: Record<string, unknown>;

  livething: Record<string, unknown>;

  /** The one user the frame was addressed to; leave it out for a whole-scope broadcast. */
  userId?: string;

  /** The resume tokens of the connections the frame was sent to, when it went to chosen ones. */
  recipients?: readonly string[];

  now: number;
}

export function buildReplayRow(event: string, params: BuildReplayRowOptions): ReplayRow {
  const { options, payload, livething, now } = params;
  const userId = params.userId || null;
  const recipients = params.recipients ? JSON.stringify(params.recipients) : null;
  const seq = livething.deliverySeq;
  const messageId = livething.messageId;

  if (typeof seq !== 'number' || typeof messageId !== 'string') {
    throw new Error(
      '[livething] replay requires `sequence` and `dedup` enabled in the same scope.',
    );
  }

  const scope = readReplayScope(livething);
  const type = options.type ?? 'history';
  const snapshotKey = type === 'snapshot' ? (options.snapshotKey?.(event, payload) ?? event) : null;

  return {
    rowKey: buildReplayRowKey(type, scope, { messageId, snapshotKey, userId, recipients }),
    messageId,
    seq,
    event,
    payload: JSON.stringify(payload),
    channel: scope.channel,
    channelFamily: scope.channelFamily,
    userId,
    recipients,
    snapshotKey,
    createdAt: now,
  };
}

function toReplayRow(row: ReplayRow): ReplayRow {
  return {
    rowKey: String(row.rowKey),
    messageId: String(row.messageId),
    seq: Number(row.seq),
    event: String(row.event),
    payload: String(row.payload),
    channel: (row.channel as string | null) ?? null,
    channelFamily: (row.channelFamily as string | null) ?? null,
    userId: (row.userId as string | null) ?? null,
    recipients: (row.recipients as string | null) ?? null,
    snapshotKey: (row.snapshotKey as string | null) ?? null,
    createdAt: Number(row.createdAt),
  };
}

/**
 * Load one replay row by its primary key.
 */
export function getReplayRowByKey(
  sql: Pick<SQLProvider, 'exec'>,
  rowKey: string,
): ReplayRow | null {
  const row = sql
    .exec<ReplayRow>(
      `
        SELECT ${REPLAY_ROW_COLUMNS}
        FROM __livething_replay
        WHERE rowKey = ?
      `,
      rowKey,
    )
    .one();

  return row ? toReplayRow(row) : null;
}

/**
 * Delete one replay row by key.
 */
function deleteReplayRow(sql: Pick<SQLProvider, 'exec'>, rowKey: string): void {
  sql.exec(
    `
      DELETE FROM __livething_replay
      WHERE rowKey = ?
    `,
    rowKey,
  );
}

/**
 * Convert a stored replay row into the reducer-facing snapshot value shape.
 */
function toReplaySnapshotValue(row: ReplayRow): ReplaySnapshotValue {
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
  flush: (sql: Pick<SQLProvider, 'exec' | 'limits'>) => void;
}

export interface PersistReplayMessageOptions {
  options: ReplayOptions;

  event: string;

  payload: Record<string, unknown>;

  livething: Record<string, unknown>;

  /** The one user the frame was addressed to; leave it out for a whole-scope broadcast. */
  userId?: string;

  /** The resume tokens of the connections the frame was sent to, when it went to chosen ones. */
  recipients?: readonly string[];

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
  postFlush?: (sql: Pick<SQLProvider, 'exec' | 'limits'>) => void;

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
  sql: Pick<SQLProvider, 'exec' | 'transaction'>,
  opts: PersistReplayMessageOptions,
): ReplayRow | null {
  const { options, event, payload, livething, userId, recipients, now } = opts;
  const { scope, postFlush, validateReduced } = opts;
  function noopPostFlush(): void {}

  const row = buildReplayRow(event, { options, payload, livething, userId, recipients, now });

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
      const fromDisk = getReplayRowByKey(sql, row.rowKey);
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
      // A reducer's result is user code, so it gets the full payload rule: a payload whose JSON
      // is not an object is refused now, instead of breaking every later replay.
      payload: options.reduce ? serializePayload(reduced.event, reduced.payload) : row.payload,
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

  return sql.transaction(() => {
    const previousRow = getReplayRowByKey(sql, row.rowKey);
    const nextValue: ReplaySnapshotValue = { event, payload };

    const reduced = options.reduce
      ? options.reduce(previousRow ? toReplaySnapshotValue(previousRow) : null, nextValue)
      : nextValue;

    if (!reduced) {
      deleteReplayRow(sql, row.rowKey);
      return null;
    }

    if (options.reduce) validateReduced?.(reduced.event, reduced.payload);

    const snapshotRow: ReplayRow = {
      ...row,
      event: reduced.event,
      // A reducer's result is user code, so it gets the full payload rule: a payload whose JSON
      // is not an object is refused now, instead of breaking every later replay.
      payload: options.reduce ? serializePayload(reduced.event, reduced.payload) : row.payload,
    };

    storeReplayRow(sql, snapshotRow);

    return snapshotRow;
  });
}

/**
 * A row is keyed per audience, so a value addressed to one user or to chosen
 * connections never replaces (or is merged into) the value others see. A frame
 * sent to the connections of several users is stored as one row per user.
 */
function buildReplayRowKey(
  type: ReplayType,
  scope: ReplayPayloadScope,
  ids: ReplayRowKeyIds,
): string {
  const { messageId, snapshotKey, userId, recipients } = ids;
  if (type === 'history') {
    return recipients === null ? messageId : JSON.stringify([messageId, userId]);
  }

  return JSON.stringify([
    'snapshot',
    scope.channel ?? '',
    scope.channelFamily ?? '',
    snapshotKey ?? messageId,
    userId,
    ...(recipients === null ? [] : [recipients]),
  ]);
}

/**
 * Insert or replace one replay row.
 */
export function storeReplayRow(sql: Pick<SQLProvider, 'exec'>, row: ReplayRow): void {
  sql.exec(
    `
      INSERT OR REPLACE INTO __livething_replay (
        rowKey,
        messageId,
        seq,
        event,
        payload,
        channel,
        channelFamily,
        userId,
        recipients,
        audience,
        snapshotKey,
        createdAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    row.rowKey,
    row.messageId,
    row.seq,
    row.event,
    row.payload,
    row.channel,
    row.channelFamily,
    row.userId,
    row.recipients,
    replayAudienceOf(row.userId, row.recipients !== null),
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
  sql: Pick<SQLProvider, 'exec'>,
  scopeKey: string,
  evictedThroughSeq: number,
): void {
  sql.exec(
    `
      INSERT INTO __livething_replay_watermark (scope_key, evicted_through_seq)
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
  sql: Pick<SQLProvider, 'exec'>,
  scopeKey: string,
): number | null {
  const row = sql
    .exec<{ evicted_through_seq: number }>(
      `
        SELECT evicted_through_seq
        FROM __livething_replay_watermark
        WHERE scope_key = ?
      `,
      scopeKey,
    )
    .one();

  return row ? Number(row.evicted_through_seq) : null;
}

/**
 * Watermark key for one audience of one scope; the shared log keeps the plain scope key. An
 * audience key has three items and a channel scope key two, so a channel family named like an
 * audience (`user:bob`) never shares a key start with that audience.
 */
function replayWatermarkKey(scope: ReplayStorageScope, audience: string): string {
  const scopeKey = replayScopeKey(scope);
  return audience === SHARED_AUDIENCE ? scopeKey : JSON.stringify(['audience', audience, scopeKey]);
}

/**
 * The highest evicted `seq` a client could have received in one scope: the
 * scope's shared rows plus the rows of its own audience (`null` for none). Rows
 * of another audience never count, so their eviction cannot report a gap to
 * this client.
 */
export function readReplayGapWatermark(
  sql: Pick<SQLProvider, 'exec'>,
  scope: ReplayStorageScope,
  audience: string | null,
): number | null {
  const shared = readReplayWatermark(sql, replayScopeKey(scope));
  if (audience === null) return shared;

  const own = readReplayWatermark(sql, replayWatermarkKey(scope, audience));
  if (shared === null) return own;

  return own === null ? shared : Math.max(shared, own);
}

/** Delete one user's replay rows and gap watermarks, in every store. */
export function purgeReplayUser(
  sql: Pick<SQLProvider, 'exec' | 'transaction'>,
  userId: string,
): void {
  // A user watermark key is `JSON.stringify(['audience', audience, scopeKey])`; this is its start.
  const watermarkPrefix = `${JSON.stringify(['audience', replayAudienceOf(userId, false)]).slice(0, -1)},`;
  sql.transaction(() => {
    sql.exec('DELETE FROM __livething_replay WHERE userId = ?', userId);
    sql.exec(
      'DELETE FROM __livething_replay_watermark WHERE substr(scope_key, 1, length(?)) = ?',
      watermarkPrefix,
      watermarkPrefix,
    );
  });
}

/**
 * The SQL condition (and its bound params) that narrows the rows to the ones one replay instance
 * may own. A channel's store is matched in SQL. The server-level store owns every row except
 * those of the channels with their own `replay`. That list can be longer than an engine's
 * bound-parameter limit, so `ownsRow` leaves those rows out after the read.
 */
function ownedRowsFilter(owner: ReplayStoreOwner): { where: string; params: unknown[] } {
  if (owner.channelKey) {
    return {
      where: '(channelFamily = ? OR channel = ?)',
      params: [owner.channelKey, owner.channelKey],
    };
  }

  return { where: '1 = 1', params: [] };
}

interface ReplayRowScope {
  channel: string | null;
  channelFamily: string | null;
}

function ownsRow(owner: ReplayStoreOwner, row: ReplayRowScope): boolean {
  if (owner.channelKey) return true;

  const claimed = owner.claimedChannelKeys;
  return !(
    (row.channelFamily !== null && claimed.has(row.channelFamily)) ||
    (row.channel !== null && claimed.has(row.channel))
  );
}

/** Whether the server-level store must leave out some channels' rows. */
function skipsClaimedRows(owner: ReplayStoreOwner): boolean {
  return !owner.channelKey && owner.claimedChannelKeys.size > 0;
}

/**
 * Delete the rows one replay instance owns that are older than the max age,
 * first recording each scope's highest dropped seq as its watermark. Rows and
 * watermarks of another instance's store (a channel with its own `replay`, or
 * the server-level store seen from a channel) are left alone.
 */
export interface PruneExpiredReplayRowsOptions {
  retention: ReplayOptions['retention'] | undefined;
  now: number;
  owner: ReplayStoreOwner;
}

export function pruneExpiredReplayRows(
  sql: Pick<SQLProvider, 'exec' | 'limits'>,
  opts: PruneExpiredReplayRowsOptions,
): void {
  const { retention, now, owner } = opts;
  if (retention?.maxAgeMs === undefined) return;

  const cutoff = now - retention.maxAgeMs;
  const owned = ownedRowsFilter(owner);

  const evicted = sql
    .exec<{
      channel: string | null;
      channelFamily: string | null;
      audience: string;
      m: number;
    }>(
      `
        SELECT channel, channelFamily, audience, MAX(seq) AS m
        FROM __livething_replay
        WHERE createdAt < ?
          AND ${owned.where}
        GROUP BY channel, channelFamily, audience
      `,
      cutoff,
      ...owned.params,
    )
    .toArray()
    .filter((scope) => ownsRow(owner, scope));

  for (const scope of evicted) {
    bumpReplayWatermark(
      sql,
      replayWatermarkKey(
        {
          channel: (scope.channel as string | null) ?? null,
          channelFamily: (scope.channelFamily as string | null) ?? null,
        },
        String(scope.audience),
      ),
      Number(scope.m),
    );
  }

  if (!skipsClaimedRows(owner)) {
    sql.exec(
      `
        DELETE FROM __livething_replay
        WHERE createdAt < ?
          AND ${owned.where}
      `,
      cutoff,
      ...owned.params,
    );
    return;
  }

  // One DELETE per batch of scopes, as many as the engine's bound-parameter limit allows. The
  // cutoff takes one of the parameters, and each scope takes two.
  const scopes = new Map<string, ReplayRowScope>();
  for (const scope of evicted) {
    scopes.set(JSON.stringify([scope.channel, scope.channelFamily]), scope);
  }

  const limits = { ...sql.limits, maxBoundParams: sql.limits.maxBoundParams - 1 };
  for (const batch of chunkForBind([...scopes.values()], 2, limits)) {
    const matches = batch.map(() => '(channel IS ? AND channelFamily IS ?)').join(' OR ');
    sql.exec(
      `DELETE FROM __livething_replay WHERE createdAt < ? AND (${matches})`,
      cutoff,
      ...batch.flatMap((scope) => [scope.channel, scope.channelFamily]),
    );
  }
}

/** One audience's rows in one replay store: the unit `maxMessages` limits. */
export interface ReplayAudienceScope extends ReplayPayloadScope {
  /** From `replayAudienceOf`. */
  audience: string;
}

/**
 * Trim one audience of one replay store down to the configured maximum row
 * count, keeping its newest rows. A store is the top level or one channel; a
 * null `channel`/`channelFamily` binds to the top-level rows. Ordering by `seq`
 * is well-defined because the sequence counter is global (one counter for the
 * whole server).
 */
export function pruneReplayScopeRows(
  sql: Pick<SQLProvider, 'exec'>,
  retention: ReplayOptions['retention'] | undefined,
  scope: ReplayAudienceScope,
): void {
  if (retention?.maxMessages === undefined) return;

  const dropped = sql
    .exec<{ m: number | null }>(
      `
        SELECT MAX(seq) AS m
        FROM (
          SELECT seq
          FROM __livething_replay
          WHERE channel IS ?
            AND channelFamily IS ?
            AND audience = ?
          ORDER BY seq DESC
          LIMIT -1 OFFSET ?
        )
      `,
      scope.channel,
      scope.channelFamily,
      scope.audience,
      retention.maxMessages,
    )
    .one();
  if (dropped?.m == null) return;

  bumpReplayWatermark(sql, replayWatermarkKey(scope, scope.audience), Number(dropped.m));

  sql.exec(
    `
      DELETE FROM __livething_replay
      WHERE rowKey IN (
        SELECT rowKey
        FROM __livething_replay
        WHERE channel IS ?
          AND channelFamily IS ?
          AND audience = ?
        ORDER BY seq DESC
        LIMIT -1 OFFSET ?
      )
    `,
    scope.channel,
    scope.channelFamily,
    scope.audience,
    retention.maxMessages,
  );
}

/** Count one audience's rows in one replay store. */
function countReplayScopeRows(sql: Pick<SQLProvider, 'exec'>, scope: ReplayAudienceScope): number {
  const row = sql
    .exec<{
      n: number;
    }>(
      `SELECT COUNT(*) AS n FROM __livething_replay
       WHERE channel IS ? AND channelFamily IS ? AND audience = ?`,
      scope.channel,
      scope.channelFamily,
      scope.audience,
    )
    .one();
  return row ? Number(row.n) : 0;
}

/** The oldest `createdAt` among the rows one replay instance owns, or null when it has none. */
function minReplayCreatedAt(
  sql: Pick<SQLProvider, 'exec'>,
  owner: ReplayStoreOwner,
): number | null {
  const owned = ownedRowsFilter(owner);
  if (!skipsClaimedRows(owner)) {
    const row = sql
      .exec<{
        m: number | null;
      }>(`SELECT MIN(createdAt) AS m FROM __livething_replay WHERE ${owned.where}`, ...owned.params)
      .one();
    return row?.m == null ? null : Number(row.m);
  }

  const scopes = sql
    .exec<{ channel: string | null; channelFamily: string | null; m: number }>(
      'SELECT channel, channelFamily, MIN(createdAt) AS m FROM __livething_replay GROUP BY channel, channelFamily',
    )
    .toArray()
    .filter((scope) => ownsRow(owner, scope));
  // A loop, not Math.min(...), which throws when there are too many scopes to pass as arguments.
  let oldest: number | null = null;
  for (const scope of scopes) {
    const createdAt = Number(scope.m);
    if (oldest === null || createdAt < oldest) oldest = createdAt;
  }

  return oldest;
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

  prune(sql: Pick<SQLProvider, 'exec' | 'limits'>, opts: ReplayPruneOptions): void {
    const { retention, scope, owner, stamp } = opts;
    if (retention?.maxAgeMs !== undefined) {
      if (!this.minSeeded) {
        this.minCreatedAt = minReplayCreatedAt(sql, owner);
        this.minSeeded = true;
      } else if (this.minCreatedAt === null || stamp < this.minCreatedAt) {
        this.minCreatedAt = stamp;
      }

      if (this.minCreatedAt !== null && this.minCreatedAt < stamp - retention.maxAgeMs) {
        pruneExpiredReplayRows(sql, { retention, now: stamp, owner });
        this.minCreatedAt = minReplayCreatedAt(sql, owner);
      }
    }

    if (retention?.maxMessages !== undefined) {
      const key = replayWatermarkKey(scope, scope.audience);
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
 *
 * A row addressed to one user loads only when `scope.userId` is that user; a
 * whole-scope row loads for anyone who may read the scope. An anonymous
 * requester (`userId` null) never matches a user row, because `userId = NULL`
 * is never true in SQL. A row sent to chosen connections loads only when it
 * lists one of `scope.resumeTokens` and has the requester's user (`NULL` for
 * an anonymous requester).
 */
export function buildLoadReplayQuery(
  since: number,
  scope: ReplayLoadScope,
): { sql: string; params: unknown[] } {
  const audience = replayAudience(scope);

  if (scope.channelName) {
    if (scope.channelFamily === null) {
      return {
        sql: `
          SELECT ${REPLAY_ROW_COLUMNS}
          FROM __livething_replay
          WHERE channel IS ?
            AND channelFamily IS NULL
            AND seq > ?
            AND ${audience.sql}
          ORDER BY seq ASC
        `,
        params: [scope.channelName, since, ...audience.params],
      };
    }

    return {
      sql: `
        SELECT ${REPLAY_ROW_COLUMNS}
        FROM __livething_replay
        WHERE channel IS ?
          AND channelFamily IS ?
          AND seq > ?
          AND ${audience.sql}
        ORDER BY seq ASC
      `,
      params: [scope.channelName, scope.channelFamily, since, ...audience.params],
    };
  }

  // Top-level replay returns every non-channel row the requester may see.
  // There are only two replay stores, top-level and per-channel. The limit in
  // `pruneReplayScopeRows` matches this read (it counts the whole top-level
  // store as one), so `maxMessages` bounds what this read returns.
  return {
    sql: `
      SELECT ${REPLAY_ROW_COLUMNS}
      FROM __livething_replay
      WHERE channel IS NULL
        AND channelFamily IS NULL
        AND seq > ?
        AND ${audience.sql}
      ORDER BY seq ASC
    `,
    params: [since, ...audience.params],
  };
}

function replayAudience(scope: ReplayLoadScope): { sql: string; params: unknown[] } {
  const shared = '(recipients IS NULL AND (userId IS NULL OR userId = ?))';
  const resumeTokens = scope.resumeTokens ?? [];
  if (resumeTokens.length === 0) return { sql: shared, params: [scope.userId] };

  const tokens = resumeTokens.map(() => '?').join(', ');

  return {
    sql: `(${shared} OR (recipients IS NOT NULL AND userId IS ? AND EXISTS (
      SELECT 1 FROM json_each(recipients) WHERE value IN (${tokens})
    )))`,
    params: [scope.userId, scope.userId, ...resumeTokens],
  };
}

/**
 * Load replay rows for the active scope after the client's last seen seq.
 */
export function loadReplayRows(
  sql: Pick<SQLProvider, 'exec'>,
  since: number,
  scope: ReplayLoadScope,
): ReplayRow[] {
  const query = buildLoadReplayQuery(since, scope);
  return sql
    .exec<ReplayRow>(query.sql, ...query.params)
    .toArray()
    .map(toReplayRow);
}
