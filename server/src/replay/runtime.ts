import { ENGINE_CHANNEL_META } from '~/_engine/contexts/contexts.ts';
import { serializePayload } from '~/_engine/runtime/json-guard.ts';
import * as Protocol from '~/_engine/runtime/protocol.ts';
import {
  storedRowBytes,
  storedRowSkip,
  storedRowStorageBytes,
  toBytes,
} from '~/_engine/runtime/stored-row.ts';
import { chunkForBind } from '~/_engine/sql-batch.ts';
import * as ChannelPrimitive from '~/channel/runtime.ts';
import type { EngineChannelMeta } from '~/_engine/contexts/types.ts';
import type { StoredRowLimits, StoredRowSkip } from '~/_engine/runtime/stored-row.ts';
import type { FrameRecipient, RuntimeConnection } from '~/_engine/runtime/types.ts';
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
    -- The JSON payload, or the info of a binary event.
    payload TEXT NOT NULL,
    -- The bytes of a binary event, or NULL for a JSON event.
    binaryPayload BLOB,
    -- The UTF-8 bytes of payload plus the bytes of binaryPayload: what retention.maxBytes counts.
    rowBytes INTEGER NOT NULL,
    channel TEXT,
    channelFamily TEXT,
    -- The one user the frame was addressed to, or NULL when it went to everyone in its scope.
    userId TEXT,
    -- Who may read the row: see replayAudienceOf, or 'chosen' when __livething_replay_recipient says.
    audience TEXT NOT NULL DEFAULT '',
    -- The resume token of the sender a broadcast left out, or NULL.
    excludedToken TEXT,
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

// rowBytes is in the index, so the maxBytes check sums the index and never reads the payloads.
const CREATE_REPLAY_AUDIENCE_SEQ_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS __livething_idx_replay_audience_seq
  ON __livething_replay (channel, channelFamily, audience, seq, rowBytes)
`;

// One row per connection a frame was sent to. The payload stays in __livething_replay, once, and
// the row there lives until its last recipient row is gone. seq, rowBytes, scope and createdAt are
// copied here so each audience's retention reads this table alone.
const CREATE_REPLAY_RECIPIENT_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS __livething_replay_recipient (
    rowKey TEXT NOT NULL,
    resumeToken TEXT NOT NULL,
    audience TEXT NOT NULL,
    seq INTEGER NOT NULL,
    rowBytes INTEGER NOT NULL,
    channel TEXT,
    channelFamily TEXT,
    createdAt INTEGER NOT NULL,
    -- Reserved JSON blob: lets us add per-row fields later without a migration.
    metadata TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (rowKey, resumeToken)
  )
`;

const CREATE_REPLAY_RECIPIENT_AUDIENCE_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS __livething_idx_replay_recipient_audience_seq
  ON __livething_replay_recipient (channel, channelFamily, audience, seq, rowBytes)
`;

const CREATE_REPLAY_WATERMARK_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS __livething_replay_watermark (
    scope_key TEXT NOT NULL,
    audience TEXT NOT NULL DEFAULT '',
    evicted_through_seq INTEGER NOT NULL,
    -- Reserved JSON blob: lets us add per-scope fields later without a migration.
    metadata TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (scope_key, audience)
  )
`;

// @__PURE__ lets the bundler drop this when unused; see channel/storage.ts.
const REPLAY_SCHEMA_SQL = /* @__PURE__ */ [
  CREATE_REPLAY_TABLE_SQL,
  CREATE_REPLAY_SEQ_INDEX_SQL,
  CREATE_REPLAY_SCOPE_SEQ_INDEX_SQL,
  CREATE_REPLAY_AUDIENCE_SEQ_INDEX_SQL,
  CREATE_REPLAY_RECIPIENT_TABLE_SQL,
  CREATE_REPLAY_RECIPIENT_AUDIENCE_INDEX_SQL,
  CREATE_REPLAY_WATERMARK_TABLE_SQL,
].join(';\n');

const REPLAY_ROW_COLUMNS = `
  rowKey,
  messageId,
  seq,
  event,
  payload,
  binaryPayload,
  rowBytes,
  channel,
  channelFamily,
  userId,
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
   * loads only when one of them was sent it under the requester's user. A
   * broadcast that left out one of them does not load.
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
  recipients: readonly FrameRecipient[] | null;
}

interface ReplayPruneOptions {
  retention: ReplayOptions['retention'] | undefined;
  /** The audiences that just got a row, all in one store. */
  scopes: readonly ReplayAudienceScope[];
  owner: ReplayStoreOwner;
  stamp: number;
  /** The `rowBytes` of the row just stored. */
  rowBytes: number;
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
/** The `audience` of a stored frame whose readers are its `__livething_replay_recipient` rows. */
const CHOSEN_AUDIENCE = 'chosen';
const ANONYMOUS_AUDIENCE_PREFIX = 'anon:';
/**
 * A watermark every anonymous token also reads: the seq below which rows were dropped for the
 * total limit, or watermarks were folded together. It can report a gap a client did not have, but
 * only after that limit was hit, and it never hides a real one.
 */
const ANONYMOUS_FLOOR_AUDIENCE = 'anonymous';

/**
 * How many anonymous tokens' worth of rows and watermarks one store keeps. Each token has its own
 * `maxMessages`, so tokens that never come back would otherwise grow storage without limit.
 */
export const MAX_ANONYMOUS_BUDGETS = 1024;

/**
 * Past the total limit, drop down to this share of it, so the costly scan runs once per many writes.
 */
const ANONYMOUS_PRUNE_KEEP_RATIO = 0.9;

/** How many audiences' row counts the prune gate caches; a miss only costs one count query. */
const MAX_CACHED_AUDIENCE_COUNTS = 10_000;

/**
 * The retention budget and gap watermark a row counts toward: the shared log, one user's rows
 * (sent to that user, or to chosen connections of theirs), or one anonymous resume token's rows.
 * Each has its own `maxMessages` and its own watermark, so one audience's rows never push out
 * another's or report a gap to a client that never had them.
 */
export function replayAudienceOf(userId: string | null, resumeToken?: string): string {
  if (userId) return `user:${userId}`;

  return resumeToken ? `${ANONYMOUS_AUDIENCE_PREFIX}${resumeToken}` : SHARED_AUDIENCE;
}

/** The audiences, beside the shared log, whose evicted rows a requester could have received. */
export function replayAudiencesOfRequester(
  userId: string | null,
  resumeTokens: readonly string[],
): string[] {
  if (userId) return [replayAudienceOf(userId)];

  if (resumeTokens.length === 0) return [];

  return [
    ANONYMOUS_FLOOR_AUDIENCE,
    ...resumeTokens.map((resumeToken) => replayAudienceOf(null, resumeToken)),
  ];
}

/** The audiences one stored frame counts toward: each user it reached, and each anonymous token. */
export function replayAudiencesOfRow(
  userId: string | undefined,
  recipients: readonly FrameRecipient[] | undefined,
): string[] {
  if (!recipients) return [replayAudienceOf(userId || null)];

  return [
    ...new Set(
      recipients.map((recipient) =>
        replayAudienceOf(recipient.userId || null, recipient.resumeToken),
      ),
    ),
  ];
}

/**
 * Convert one outgoing frame into the replay row that should be stored. The
 * `payload` column holds the pure user payload; sequence number, message id,
 * and scope come from the frame's `__livething`.
 */
export interface BuildReplayRowOptions {
  options: ReplayOptions;

  payload: Record<string, unknown> | null;

  /** The bytes of a binary frame. */
  bytes?: Uint8Array;

  livething: Record<string, unknown>;

  /** The one user the frame was addressed to; leave it out for a whole-scope broadcast. */
  userId?: string;

  /** The connections the frame was sent to, when it went to chosen ones. */
  recipients?: readonly FrameRecipient[];

  /** The resume token of the sender a broadcast left out. */
  excludedToken?: string;

  now: number;
}

export function buildReplayRow(event: string, params: BuildReplayRowOptions): ReplayRow {
  const { options, payload, bytes, livething, now } = params;
  const userId = params.userId || null;
  const recipients = params.recipients ?? null;
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
  const payloadJson = JSON.stringify(payload);

  return {
    rowKey: buildReplayRowKey(type, scope, { messageId, snapshotKey, userId, recipients }),
    messageId,
    seq,
    event,
    payload: payloadJson,
    binaryPayload: bytes ?? null,
    rowBytes: storedRowBytes(payloadJson, bytes),
    channel: scope.channel,
    channelFamily: scope.channelFamily,
    userId,
    recipients,
    excludedToken: params.excludedToken ?? null,
    snapshotKey,
    createdAt: now,
  };
}

/** About how many bytes one row takes in storage. Compared with the SQL engine's row limit. */
function replayRowStorageBytes(row: ReplayRow): number {
  return storedRowStorageBytes(row.rowBytes, [
    row.rowKey,
    row.messageId,
    row.event,
    row.channel,
    row.channelFamily,
    row.userId,
    row.snapshotKey,
    row.excludedToken,
  ]);
}

function toReplayRow(row: ReplayRow): ReplayRow {
  return {
    rowKey: String(row.rowKey),
    messageId: String(row.messageId),
    seq: Number(row.seq),
    event: String(row.event),
    payload: String(row.payload),
    binaryPayload: toBytes(row.binaryPayload),
    rowBytes: Number(row.rowBytes),
    channel: (row.channel as string | null) ?? null,
    channelFamily: (row.channelFamily as string | null) ?? null,
    userId: (row.userId as string | null) ?? null,
    recipients: null,
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
  sql.exec('DELETE FROM __livething_replay_recipient WHERE rowKey = ?', rowKey);
  sql.exec(
    `
      DELETE FROM __livething_replay
      WHERE rowKey = ?
    `,
    rowKey,
  );
}

/** Delete the rows among `rowKeys` that have no recipient left. */
function deleteRowsWithNoRecipient(
  sql: Pick<SQLProvider, 'exec' | 'limits'>,
  rowKeys: readonly string[],
): void {
  for (const batch of chunkForBind(rowKeys, 1, sql.limits)) {
    sql.exec(
      `
        DELETE FROM __livething_replay
        WHERE rowKey IN (${batch.map(() => '?').join(', ')})
          AND NOT EXISTS (
            SELECT 1 FROM __livething_replay_recipient AS recipient
            WHERE recipient.rowKey = __livething_replay.rowKey
          )
      `,
      ...batch,
    );
  }
}

/**
 * Convert a stored replay row into the reducer-facing snapshot value shape.
 */
function toReplaySnapshotValue(row: ReplayRow): ReplaySnapshotValue {
  return {
    event: row.event,
    payload: JSON.parse(row.payload) as Record<string, unknown> | null,
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

  payload: Record<string, unknown> | null;

  /** The bytes of a binary frame. Only history mode stores them. */
  bytes?: Uint8Array;

  livething: Record<string, unknown>;

  /** The one user the frame was addressed to; leave it out for a whole-scope broadcast. */
  userId?: string;

  /** The connections the frame was sent to, when it went to chosen ones. */
  recipients?: readonly FrameRecipient[];

  /** The resume token of the sender a broadcast left out. */
  excludedToken?: string;

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
   * this callback. `rowBytes` is the written row's, or 0 when the row was deleted.
   */
  postFlush?: (sql: Pick<SQLProvider, 'exec' | 'limits'>, rowBytes: number) => void;

  /**
   * Validate the value a `reduce` produced against the public contract before
   * it is stored. Only the reducer can introduce a shape the live send didn't
   * already check, so this runs solely on reduced values. It should throw if
   * the event/payload doesn't conform — keeping the replay-from-storage path
   * trusted. Not called when no `reduce` is configured.
   */
  validateReduced?: (event: string, payload: Record<string, unknown> | null) => void;

  /** The adapter's `sendBytes`. A bigger row is not stored (see `ReplayRowLimits`). */
  sendBytes?: number;

  /** Called for a row that was not stored because it is over a limit. */
  onRowTooBig?: (row: ReplayRow, skip: StoredRowSkip) => void;
}

/**
 * Persist one replayable outgoing frame.
 *
 * History mode stores every frame. Snapshot mode stores one current value per
 * logical key, using the configured reducer when present.
 */
export function persistReplayMessage(
  sql: Pick<SQLProvider, 'exec' | 'transaction' | 'limits'>,
  opts: PersistReplayMessageOptions,
): ReplayRow | null {
  const { options, event, payload, livething, userId, recipients, excludedToken, now } = opts;
  const { scope, postFlush, validateReduced } = opts;
  function noopPostFlush(): void {}

  const row = buildReplayRow(event, {
    options,
    payload,
    bytes: opts.bytes,
    livething,
    userId,
    recipients,
    excludedToken,
    now,
  });

  const limits = { sendBytes: opts.sendBytes, maxBytes: options.retention?.maxBytes };
  function store(sqlForStore: Pick<SQLProvider, 'exec' | 'limits'>, stored: ReplayRow): boolean {
    const skip = storeReplayRow(sqlForStore, stored, limits);
    if (!skip) return true;

    opts.onRowTooBig?.(stored, skip);
    return false;
  }

  if ((options.type ?? 'history') === 'history') return store(sql, row) ? row : null;

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
          prune(sqlForFlush, 0);
        },
      });
      return null;
    }

    if (options.reduce) validateReduced?.(reduced.event, reduced.payload);

    const snapshotRow = toSnapshotRow(row, reduced, options.reduce !== undefined);

    scope.pendingSnapshotFlushes.set(row.rowKey, {
      row: snapshotRow,
      flush: (sqlForFlush) => {
        prune(sqlForFlush, store(sqlForFlush, snapshotRow) ? snapshotRow.rowBytes : 0);
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

    const snapshotRow = toSnapshotRow(row, reduced, options.reduce !== undefined);

    return store(sql, snapshotRow) ? snapshotRow : null;
  });
}

/** The row a snapshot stores: the new row, with the value its `reduce` returned. */
function toSnapshotRow(
  row: ReplayRow,
  reduced: ReplaySnapshotValue,
  wasReduced: boolean,
): ReplayRow {
  if (!wasReduced) return { ...row, event: reduced.event };

  // A reducer's result is user code, so it gets the full payload rule: a payload whose JSON
  // is not an object is refused now, instead of breaking every later replay.
  const payload = serializePayload(reduced.event, reduced.payload);
  return {
    ...row,
    event: reduced.event,
    payload,
    rowBytes: storedRowBytes(payload, row.binaryPayload),
  };
}

/**
 * A history frame is one row, however many connections it reached. A snapshot row
 * is keyed per audience, so a value addressed to one user or to chosen connections
 * never replaces (or is merged into) the value others see.
 */
function buildReplayRowKey(
  type: ReplayType,
  scope: ReplayPayloadScope,
  ids: ReplayRowKeyIds,
): string {
  const { messageId, snapshotKey, userId, recipients } = ids;
  if (type === 'history') return messageId;

  return JSON.stringify([
    'snapshot',
    scope.channel ?? '',
    scope.channelFamily ?? '',
    snapshotKey ?? messageId,
    userId,
    ...(recipients?.map((recipient) => recipient.resumeToken) ?? []),
  ]);
}

/** The limits besides the SQL engine's own row limit that keep a row out of replay. */
type ReplayRowLimits = Omit<StoredRowLimits, 'maxValueBytes'>;

/**
 * Insert or replace one replay row, and one recipient row per connection it went to.
 *
 * A row over a limit is not stored, and this returns the limit. Over the SQL engine's row limit
 * (`limits.maxValueBytes`) the write would throw; see `ReplayRowLimits` for the others. A
 * snapshot value it would replace is deleted, so replay never sends an old value as the current
 * one.
 */
export function storeReplayRow(
  sql: Pick<SQLProvider, 'exec' | 'limits'>,
  row: ReplayRow,
  limits: ReplayRowLimits = {},
): StoredRowSkip | null {
  const skip = storedRowSkip(
    { storageBytes: replayRowStorageBytes(row), rowBytes: row.rowBytes },
    { ...limits, maxValueBytes: sql.limits.maxValueBytes },
  );
  if (skip) {
    deleteReplayRow(sql, row.rowKey);
    return skip;
  }

  sql.exec(
    `
      INSERT OR REPLACE INTO __livething_replay (
        rowKey,
        messageId,
        seq,
        event,
        payload,
        binaryPayload,
        rowBytes,
        channel,
        channelFamily,
        userId,
        audience,
        excludedToken,
        snapshotKey,
        createdAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    row.rowKey,
    row.messageId,
    row.seq,
    row.event,
    row.payload,
    row.binaryPayload,
    row.rowBytes,
    row.channel,
    row.channelFamily,
    row.userId,
    row.recipients ? CHOSEN_AUDIENCE : replayAudienceOf(row.userId),
    row.excludedToken ?? null,
    row.snapshotKey,
    row.createdAt,
  );

  // The row's own columns are bound once for the batch, so a batch holds many recipients even on
  // an engine with a low bound-parameter limit. The rowKey takes one of the parameters.
  const bindLimits = { ...sql.limits, maxBoundParams: sql.limits.maxBoundParams - 1 };
  for (const batch of chunkForBind(row.recipients ?? [], 2, bindLimits)) {
    sql.exec(
      `
        WITH sent(resumeToken, audience) AS (VALUES ${batch.map(() => '(?, ?)').join(', ')})
        INSERT OR REPLACE INTO __livething_replay_recipient
          (rowKey, resumeToken, audience, seq, rowBytes, channel, channelFamily, createdAt)
        SELECT stored.rowKey, sent.resumeToken, sent.audience, stored.seq, stored.rowBytes,
          stored.channel, stored.channelFamily, stored.createdAt
        FROM sent JOIN __livething_replay AS stored ON stored.rowKey = ?
      `,
      ...batch.flatMap((recipient) => [
        recipient.resumeToken,
        replayAudienceOf(recipient.userId || null, recipient.resumeToken),
      ]),
      row.rowKey,
    );
  }

  return null;
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
  bumpAudienceWatermark(sql, { scopeKey, evictedThroughSeq, audience: SHARED_AUDIENCE });
}

interface ReplayAudienceWatermark {
  scopeKey: string;
  evictedThroughSeq: number;
  audience: string;
}

/** {@link bumpReplayWatermark} for one audience of one scope. */
export function bumpAudienceWatermark(
  sql: Pick<SQLProvider, 'exec'>,
  mark: ReplayAudienceWatermark,
): void {
  const { scopeKey, evictedThroughSeq, audience } = mark;
  sql.exec(
    `
      INSERT INTO __livething_replay_watermark (scope_key, audience, evicted_through_seq)
      VALUES (?, ?, ?)
      ON CONFLICT(scope_key, audience) DO UPDATE SET
        evicted_through_seq = MAX(evicted_through_seq, excluded.evicted_through_seq)
    `,
    scopeKey,
    audience,
    evictedThroughSeq,
  );

  if (audience.startsWith(ANONYMOUS_AUDIENCE_PREFIX)) foldAnonymousWatermarks(sql, scopeKey);
}

/**
 * Past `MAX_ANONYMOUS_BUDGETS` token watermarks in one store, fold the lowest into the floor every
 * anonymous token reads, so tokens that never come back cannot grow this table without limit.
 */
function foldAnonymousWatermarks(sql: Pick<SQLProvider, 'exec'>, scopeKey: string): void {
  const fold = sql
    .exec<{ evicted_through_seq: number }>(
      `
        SELECT evicted_through_seq
        FROM __livething_replay_watermark
        WHERE scope_key = ? AND substr(audience, 1, ?) = ?
        ORDER BY evicted_through_seq DESC
        LIMIT 1 OFFSET ?
      `,
      scopeKey,
      ANONYMOUS_AUDIENCE_PREFIX.length,
      ANONYMOUS_AUDIENCE_PREFIX,
      MAX_ANONYMOUS_BUDGETS,
    )
    .one();
  if (!fold) return;

  const seq = Number(fold.evicted_through_seq);
  bumpAudienceWatermark(sql, {
    scopeKey,
    evictedThroughSeq: seq,
    audience: ANONYMOUS_FLOOR_AUDIENCE,
  });
  sql.exec(
    `
      DELETE FROM __livething_replay_watermark
      WHERE scope_key = ? AND substr(audience, 1, ?) = ? AND evicted_through_seq <= ?
    `,
    scopeKey,
    ANONYMOUS_AUDIENCE_PREFIX.length,
    ANONYMOUS_AUDIENCE_PREFIX,
    seq,
  );
}

/**
 * Read one scope's eviction watermark, or `null` when nothing has been evicted
 * from that scope yet.
 */
export function readReplayWatermark(
  sql: Pick<SQLProvider, 'exec'>,
  scopeKey: string,
  audience: string = SHARED_AUDIENCE,
): number | null {
  const row = sql
    .exec<{ evicted_through_seq: number }>(
      `
        SELECT evicted_through_seq
        FROM __livething_replay_watermark
        WHERE scope_key = ? AND audience = ?
      `,
      scopeKey,
      audience,
    )
    .one();

  return row ? Number(row.evicted_through_seq) : null;
}

/**
 * The highest evicted `seq` a client could have received in one scope: the
 * scope's shared rows plus the rows of its own audiences. Rows of another
 * audience never count, so their eviction cannot report a gap to this client.
 */
export function readReplayGapWatermark(
  sql: Pick<SQLProvider, 'exec'>,
  scope: ReplayStorageScope,
  audiences: readonly string[],
): number | null {
  const all = [SHARED_AUDIENCE, ...audiences];
  const row = sql
    .exec<{ m: number | null }>(
      `
        SELECT MAX(evicted_through_seq) AS m
        FROM __livething_replay_watermark
        WHERE scope_key = ? AND audience IN (${all.map(() => '?').join(', ')})
      `,
      replayScopeKey(scope),
      ...all,
    )
    .one();

  return row?.m == null ? null : Number(row.m);
}

/** Delete one user's replay rows and gap watermarks, in every store. */
export function purgeReplayUser(
  sql: Pick<SQLProvider, 'exec' | 'transaction' | 'limits'>,
  userId: string,
): void {
  const audience = replayAudienceOf(userId);
  sql.transaction(() => {
    const sentToUser = sql
      .exec<{ rowKey: string }>(
        'SELECT DISTINCT rowKey FROM __livething_replay_recipient WHERE audience = ?',
        audience,
      )
      .toArray()
      .map((row) => String(row.rowKey));
    sql.exec('DELETE FROM __livething_replay_recipient WHERE audience = ?', audience);
    sql.exec('DELETE FROM __livething_replay WHERE audience = ?', audience);
    deleteRowsWithNoRecipient(sql, sentToUser);
    sql.exec('DELETE FROM __livething_replay_watermark WHERE audience = ?', audience);
  });
}

/** Forget one user's snapshot rows that open handler scopes queued but have not written yet. */
export function dropQueuedReplaySnapshots(
  queue: Map<string, ReplaySnapshotEntry>,
  userId: string,
): void {
  for (const [key, entry] of queue) {
    if (entry.row?.userId === userId) queue.delete(key);
  }
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
        FROM (
          SELECT channel, channelFamily, audience, seq
          FROM __livething_replay
          WHERE createdAt < ? AND audience != '${CHOSEN_AUDIENCE}' AND ${owned.where}
          UNION ALL
          SELECT channel, channelFamily, audience, seq
          FROM __livething_replay_recipient
          WHERE createdAt < ? AND ${owned.where}
        )
        GROUP BY channel, channelFamily, audience
      `,
      cutoff,
      ...owned.params,
      cutoff,
      ...owned.params,
    )
    .toArray()
    .filter((scope) => ownsRow(owner, scope));

  for (const scope of evicted) {
    bumpAudienceWatermark(sql, {
      scopeKey: replayScopeKey({
        channel: (scope.channel as string | null) ?? null,
        channelFamily: (scope.channelFamily as string | null) ?? null,
      }),
      evictedThroughSeq: Number(scope.m),
      audience: String(scope.audience),
    });
  }

  if (!skipsClaimedRows(owner)) {
    for (const table of ['__livething_replay_recipient', '__livething_replay']) {
      sql.exec(
        `DELETE FROM ${table} WHERE createdAt < ? AND ${owned.where}`,
        cutoff,
        ...owned.params,
      );
    }

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
    for (const table of ['__livething_replay_recipient', '__livething_replay']) {
      sql.exec(
        `DELETE FROM ${table} WHERE createdAt < ? AND (${matches})`,
        cutoff,
        ...batch.flatMap((scope) => [scope.channel, scope.channelFamily]),
      );
    }
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
  sql: Pick<SQLProvider, 'exec' | 'limits'>,
  retention: ReplayOptions['retention'] | undefined,
  scope: ReplayAudienceScope,
): void {
  if (retention?.maxMessages === undefined) return;

  const dropped = sql
    .exec<{ m: number | null }>(
      `
        SELECT MAX(seq) AS m
        FROM (
          SELECT seq FROM (${AUDIENCE_SEQS_SQL})
          ORDER BY seq DESC
          LIMIT -1 OFFSET ?
        )
      `,
      ...audienceSeqsParams(scope),
      retention.maxMessages,
    )
    .one();
  if (dropped?.m == null) return;

  evictAudienceThrough(sql, scope, Number(dropped.m));
}

/**
 * Trim one audience of one replay store down to `retention.maxBytes`, deleting its oldest rows
 * first, strictly by `seq`. Returns the bytes the audience holds after.
 *
 * The total is summed from the rows each time, not kept in a counter, so no deletion path (age,
 * count, purge, a snapshot replace) can leave it wrong. `rowBytes` is in the audience indexes, so
 * the sum reads only the index.
 */
function pruneReplayScopeBytes(
  sql: Pick<SQLProvider, 'exec' | 'limits'>,
  retention: ReplayOptions['retention'] | undefined,
  scope: ReplayAudienceScope,
): number {
  const total = sumReplayScopeBytes(sql, scope);
  const maxBytes = retention?.maxBytes;
  if (maxBytes === undefined || total <= maxBytes) return total;

  // The oldest row at which the running total of dropped bytes covers the excess.
  const through = sql
    .exec<{ seq: number }>(
      `
        SELECT seq FROM (
          SELECT seq, SUM(rowBytes) OVER (ORDER BY seq ROWS UNBOUNDED PRECEDING) AS dropped
          FROM (${AUDIENCE_SEQS_SQL})
        )
        WHERE dropped >= ?
        ORDER BY seq
        LIMIT 1
      `,
      ...audienceSeqsParams(scope),
      total - maxBytes,
    )
    .one();
  if (!through) return total;

  evictAudienceThrough(sql, scope, Number(through.seq));

  return sumReplayScopeBytes(sql, scope);
}

/** Delete one audience's rows in one store through `throughSeq`, raising its watermark first. */
function evictAudienceThrough(
  sql: Pick<SQLProvider, 'exec' | 'limits'>,
  scope: ReplayAudienceScope,
  throughSeq: number,
): void {
  bumpAudienceWatermark(sql, {
    scopeKey: replayScopeKey(scope),
    evictedThroughSeq: throughSeq,
    audience: scope.audience,
  });

  const scopeParams = [scope.channel, scope.channelFamily, scope.audience, throughSeq];
  const sentToAudience = sql
    .exec<{ rowKey: string }>(
      `SELECT DISTINCT rowKey FROM __livething_replay_recipient
       WHERE channel IS ? AND channelFamily IS ? AND audience = ? AND seq <= ?`,
      ...scopeParams,
    )
    .toArray()
    .map((row) => String(row.rowKey));
  sql.exec(
    `DELETE FROM __livething_replay_recipient
     WHERE channel IS ? AND channelFamily IS ? AND audience = ? AND seq <= ?`,
    ...scopeParams,
  );
  sql.exec(
    `DELETE FROM __livething_replay
     WHERE channel IS ? AND channelFamily IS ? AND audience = ? AND seq <= ?`,
    ...scopeParams,
  );
  deleteRowsWithNoRecipient(sql, sentToAudience);
}

/**
 * The messages one audience holds in one store: rows addressed to it, and rows it was a recipient
 * of. `UNION` so a frame sent to two tabs of one user counts once.
 */
const AUDIENCE_SEQS_SQL = `
  SELECT seq, rowBytes FROM __livething_replay
  WHERE channel IS ? AND channelFamily IS ? AND audience = ?
  UNION
  SELECT seq, rowBytes FROM __livething_replay_recipient
  WHERE channel IS ? AND channelFamily IS ? AND audience = ?
`;

/** Sum the bytes of one audience's rows in one replay store. */
function sumReplayScopeBytes(sql: Pick<SQLProvider, 'exec'>, scope: ReplayAudienceScope): number {
  const row = sql
    .exec<{
      b: number | null;
    }>(`SELECT SUM(rowBytes) AS b FROM (${AUDIENCE_SEQS_SQL})`, ...audienceSeqsParams(scope))
    .one();
  return row?.b == null ? 0 : Number(row.b);
}

function audienceSeqsParams(scope: ReplayAudienceScope): unknown[] {
  const params = [scope.channel, scope.channelFamily, scope.audience];
  return [...params, ...params];
}

/** Count one audience's rows in one replay store. */
function countReplayScopeRows(sql: Pick<SQLProvider, 'exec'>, scope: ReplayAudienceScope): number {
  const row = sql
    .exec<{
      n: number;
    }>(`SELECT COUNT(*) AS n FROM (${AUDIENCE_SEQS_SQL})`, ...audienceSeqsParams(scope))
    .one();
  return row ? Number(row.n) : 0;
}

/**
 * The anonymous recipient rows of one store, as an index range: a token is a UUID, and `~` sorts
 * after every character in one.
 */
const ANONYMOUS_RECIPIENTS_WHERE = `
  channel IS ? AND channelFamily IS ? AND audience >= '${ANONYMOUS_AUDIENCE_PREFIX}'
    AND audience < '${ANONYMOUS_AUDIENCE_PREFIX}~'
`;

function countAnonymousRecipients(
  sql: Pick<SQLProvider, 'exec'>,
  store: ReplayPayloadScope,
): number {
  const row = sql
    .exec<{
      n: number;
    }>(
      `SELECT COUNT(*) AS n FROM __livething_replay_recipient WHERE ${ANONYMOUS_RECIPIENTS_WHERE}`,
      store.channel,
      store.channelFamily,
    )
    .one();
  return row ? Number(row.n) : 0;
}

/**
 * Keep the newest anonymous recipient rows of one store and drop the rest, raising the floor every
 * anonymous token reads, so a client whose rows were dropped still gets its gap.
 */
function pruneAnonymousRecipients(
  sql: Pick<SQLProvider, 'exec' | 'limits'>,
  store: ReplayPayloadScope,
  keep: number,
): void {
  const storeParams = [store.channel, store.channelFamily];
  const dropped = sql
    .exec<{ m: number | null }>(
      `
        SELECT MAX(seq) AS m FROM (
          SELECT seq FROM __livething_replay_recipient
          WHERE ${ANONYMOUS_RECIPIENTS_WHERE}
          ORDER BY seq DESC
          LIMIT -1 OFFSET ?
        )
      `,
      ...storeParams,
      keep,
    )
    .one();
  if (dropped?.m == null) return;

  evictAnonymousThrough(sql, store, Number(dropped.m));
}

/** Sum the bytes of every anonymous token's rows in one store. A row counts once per token. */
function sumAnonymousBytes(sql: Pick<SQLProvider, 'exec'>, store: ReplayPayloadScope): number {
  const row = sql
    .exec<{
      b: number | null;
    }>(
      `SELECT SUM(rowBytes) AS b FROM __livething_replay_recipient WHERE ${ANONYMOUS_RECIPIENTS_WHERE}`,
      store.channel,
      store.channelFamily,
    )
    .one();
  return row?.b == null ? 0 : Number(row.b);
}

/**
 * Delete the oldest anonymous recipient rows of one store, strictly by seq, until they hold at
 * most `keepBytes`. Like the row-count total, it raises the floor every anonymous token reads.
 */
function pruneAnonymousBytes(
  sql: Pick<SQLProvider, 'exec' | 'limits'>,
  store: ReplayPayloadScope,
  keepBytes: number,
): void {
  const total = sumAnonymousBytes(sql, store);
  if (total <= keepBytes) return;

  const through = sql
    .exec<{ seq: number }>(
      `
        SELECT seq FROM (
          SELECT seq, SUM(rowBytes) OVER (ORDER BY seq ROWS UNBOUNDED PRECEDING) AS dropped
          FROM __livething_replay_recipient
          WHERE ${ANONYMOUS_RECIPIENTS_WHERE}
        )
        WHERE dropped >= ?
        ORDER BY seq
        LIMIT 1
      `,
      store.channel,
      store.channelFamily,
      total - keepBytes,
    )
    .one();
  if (through) evictAnonymousThrough(sql, store, Number(through.seq));
}

/** Delete the anonymous recipient rows of one store through `throughSeq`, raising the floor. */
function evictAnonymousThrough(
  sql: Pick<SQLProvider, 'exec' | 'limits'>,
  store: ReplayPayloadScope,
  throughSeq: number,
): void {
  const storeParams = [store.channel, store.channelFamily];
  bumpAudienceWatermark(sql, {
    scopeKey: replayScopeKey(store),
    evictedThroughSeq: throughSeq,
    audience: ANONYMOUS_FLOOR_AUDIENCE,
  });
  const rowKeys = sql
    .exec<{ rowKey: string }>(
      `SELECT DISTINCT rowKey FROM __livething_replay_recipient
       WHERE ${ANONYMOUS_RECIPIENTS_WHERE} AND seq <= ?`,
      ...storeParams,
      throughSeq,
    )
    .toArray()
    .map((row) => String(row.rowKey));
  sql.exec(
    `DELETE FROM __livething_replay_recipient WHERE ${ANONYMOUS_RECIPIENTS_WHERE} AND seq <= ?`,
    ...storeParams,
    throughSeq,
  );
  deleteRowsWithNoRecipient(sql, rowKeys);
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
 * in-memory row count, byte total and oldest-timestamp prove when the store is under its
 * caps, where the prune only scans and deletes nothing. All are seeded from the
 * table on first use, so a hibernation wake stays correct, then maintained as
 * history rows are stored. Skipping an under-cap prune is exactly what the prune
 * itself would have done, so eviction and the gap watermark are unchanged.
 */
export class ReplayPruneGate {
  private minCreatedAt: number | null = null;
  private minSeeded = false;
  private readonly scopeCounts = new Map<string, number>();
  private readonly scopeBytes = new Map<string, number>();
  private readonly anonymousCounts = new Map<string, number>();
  private readonly anonymousBytes = new Map<string, number>();

  /** Forget every cached total, so each is read from the table again. */
  reset(): void {
    this.minSeeded = false;
    this.scopeCounts.clear();
    this.scopeBytes.clear();
    this.anonymousCounts.clear();
    this.anonymousBytes.clear();
  }

  prune(sql: Pick<SQLProvider, 'exec' | 'limits'>, opts: ReplayPruneOptions): void {
    const { retention, scopes, owner, stamp, rowBytes } = opts;
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

    if (this.scopeCounts.size + scopes.length > MAX_CACHED_AUDIENCE_COUNTS) {
      this.scopeCounts.clear();
    }

    for (const scope of scopes) {
      if (retention?.maxMessages === undefined) continue;

      const key = JSON.stringify([replayScopeKey(scope), scope.audience]);
      const cached = this.scopeCounts.get(key);
      const count = cached === undefined ? countReplayScopeRows(sql, scope) : cached + 1;
      if (count > retention.maxMessages) {
        pruneReplayScopeRows(sql, retention, scope);
        this.scopeCounts.set(key, retention.maxMessages);
      } else {
        this.scopeCounts.set(key, count);
      }
    }

    this.pruneBytes(sql, { retention, scopes, rowBytes });
    this.pruneAnonymousTotal(sql, { retention, scopes, rowBytes });
  }

  /**
   * Hold each audience to `retention.maxBytes` after a row of `rowBytes` was written to it. The
   * cached total only grows here, while deletions and snapshot replaces shrink the real one, so
   * it is never too small. Over the limit, the prune sums the real rows before it deletes any.
   */
  pruneBytes(
    sql: Pick<SQLProvider, 'exec' | 'limits'>,
    write: Pick<ReplayPruneOptions, 'retention' | 'scopes' | 'rowBytes'>,
  ): void {
    const { retention, scopes, rowBytes } = write;
    const maxBytes = retention?.maxBytes;
    if (maxBytes === undefined) return;

    if (this.scopeBytes.size + scopes.length > MAX_CACHED_AUDIENCE_COUNTS) this.scopeBytes.clear();

    for (const scope of scopes) {
      const key = JSON.stringify([replayScopeKey(scope), scope.audience]);
      const cached = this.scopeBytes.get(key);
      const bytes = cached === undefined ? sumReplayScopeBytes(sql, scope) : cached + rowBytes;
      this.scopeBytes.set(
        key,
        bytes > maxBytes ? pruneReplayScopeBytes(sql, retention, scope) : bytes,
      );
    }
  }

  /** Hold one store's anonymous recipient rows to `MAX_ANONYMOUS_BUDGETS` tokens' worth. */
  pruneAnonymousTotal(
    sql: Pick<SQLProvider, 'exec' | 'limits'>,
    write: Pick<ReplayPruneOptions, 'retention' | 'scopes' | 'rowBytes'>,
  ): void {
    const { retention, scopes, rowBytes } = write;
    const [first] = scopes;
    if (!first) return;

    const added = scopes.filter((scope) =>
      scope.audience.startsWith(ANONYMOUS_AUDIENCE_PREFIX),
    ).length;
    if (added === 0) return;

    const key = replayScopeKey(first);
    if (retention?.maxMessages !== undefined) {
      const cap = retention.maxMessages * MAX_ANONYMOUS_BUDGETS;
      const cached = this.anonymousCounts.get(key);
      const count = cached === undefined ? countAnonymousRecipients(sql, first) : cached + added;
      if (count <= cap) {
        this.anonymousCounts.set(key, count);
      } else {
        pruneAnonymousRecipients(sql, first, Math.floor(cap * ANONYMOUS_PRUNE_KEEP_RATIO));
        this.anonymousCounts.set(key, countAnonymousRecipients(sql, first));
      }
    }

    // Each token may hold `maxBytes`, so the tokens of one store together also hold at most
    // `maxBytes`. The cache is never too small, as in `pruneBytes`.
    if (retention?.maxBytes !== undefined) {
      const cached = this.anonymousBytes.get(key);
      const bytes =
        cached === undefined ? sumAnonymousBytes(sql, first) : cached + added * rowBytes;
      if (bytes <= retention.maxBytes) {
        this.anonymousBytes.set(key, bytes);
      } else {
        const keep = Math.floor(retention.maxBytes * ANONYMOUS_PRUNE_KEEP_RATIO);
        pruneAnonymousBytes(sql, first, keep);
        this.anonymousBytes.set(key, sumAnonymousBytes(sql, first));
      }
    }
  }
}

/**
 * Build the SQL string and bound params for one `loadReplayRows` call.
 *
 * A row addressed to one user loads only when `scope.userId` is that user; a
 * whole-scope row loads for anyone who may read the scope, unless it left out a
 * sender showing one of `scope.resumeTokens`. A row sent to chosen connections
 * loads only when one of `scope.resumeTokens` has a recipient row in the
 * requester's audience: its user, or, for an anonymous requester, that token's
 * own audience.
 */
export function buildLoadReplayQuery(
  since: number,
  scope: ReplayLoadScope,
  page: ReplayQueryPage = {},
): { sql: string; params: unknown[] } {
  const audience = replayAudience(scope);
  const store = replayStoreWhere(scope);
  const through = page.throughSeq === undefined ? '' : 'AND seq <= ?';
  const limit = page.limit === undefined ? '' : 'LIMIT ?';

  return {
    sql: `
      SELECT ${page.columns ?? REPLAY_ROW_COLUMNS}
      FROM __livething_replay
      WHERE ${store.sql}
        AND seq > ?
        ${through}
        AND ${audience.sql}
      ORDER BY seq ASC
      ${limit}
    `,
    params: [
      ...store.params,
      since,
      ...(page.throughSeq === undefined ? [] : [page.throughSeq]),
      ...audience.params,
      ...(page.limit === undefined ? [] : [page.limit]),
    ],
  };
}

/** What a `buildLoadReplayQuery` reads: other columns, rows up to a seq, and how many. */
interface ReplayQueryPage {
  columns?: string;
  throughSeq?: number;
  limit?: number;
}

/**
 * The store the requester asks for: one channel (a static one has a NULL family), or the
 * top level. There are only two kinds of replay store.
 */
function replayStoreWhere(scope: ReplayLoadScope): { sql: string; params: unknown[] } {
  if (!scope.channelName) {
    return { sql: 'channel IS NULL AND channelFamily IS NULL', params: [] };
  }

  if (scope.channelFamily === null) {
    return { sql: 'channel IS ? AND channelFamily IS NULL', params: [scope.channelName] };
  }

  return {
    sql: 'channel IS ? AND channelFamily IS ?',
    params: [scope.channelName, scope.channelFamily],
  };
}

function replayAudience(scope: ReplayLoadScope): { sql: string; params: unknown[] } {
  const shared = `audience = '${SHARED_AUDIENCE}'`;
  // `NULL` for an anonymous requester, so it never matches a row addressed to a user.
  const userAudience = scope.userId ? replayAudienceOf(scope.userId) : null;
  const addressed = 'audience = ?';
  const resumeTokens = scope.resumeTokens ?? [];
  if (resumeTokens.length === 0) {
    return { sql: `(${shared} OR ${addressed})`, params: [userAudience] };
  }

  const tokens = resumeTokens.map(() => '?').join(', ');
  const recipientAudience = userAudience
    ? { sql: 'recipient.audience = ?', params: [userAudience] }
    : {
        sql: `recipient.audience = '${ANONYMOUS_AUDIENCE_PREFIX}' || recipient.resumeToken`,
        params: [],
      };

  return {
    sql: `(
      (${shared} AND (excludedToken IS NULL OR excludedToken NOT IN (${tokens})))
      OR ${addressed}
      OR (audience = '${CHOSEN_AUDIENCE}' AND EXISTS (
        SELECT 1 FROM __livething_replay_recipient AS recipient
        WHERE recipient.rowKey = __livething_replay.rowKey
          AND recipient.resumeToken IN (${tokens})
          AND ${recipientAudience.sql}
      ))
    )`,
    params: [...resumeTokens, userAudience, ...resumeTokens, ...recipientAudience.params],
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

/** Which rows one `loadReplayPage` call reads, and how many. */
interface ReplayPageLimit {
  /** Read the rows after this seq. */
  since: number;
  /** Load no row with a higher seq: the highest seq stored when the catch-up started. */
  throughSeq: number;
  maxRows: number;
  /** The most `rowBytes` one page holds. A page always holds at least one row. */
  maxBytes: number;
}

/**
 * Load the next page of replay rows after `since`, in seq order. It reads only the seqs and
 * sizes first, so a page of large binary rows never loads more than `maxBytes` of them.
 */
export function loadReplayPage(
  sql: Pick<SQLProvider, 'exec'>,
  scope: ReplayLoadScope,
  limit: ReplayPageLimit,
): ReplayRow[] {
  const { since } = limit;
  const sizesQuery = buildLoadReplayQuery(since, scope, {
    columns: 'seq, rowBytes',
    throughSeq: limit.throughSeq,
    limit: limit.maxRows,
  });
  const sizes = sql
    .exec<{ seq: number; rowBytes: number }>(sizesQuery.sql, ...sizesQuery.params)
    .toArray();
  const [first] = sizes;
  if (!first) return [];

  let lastSeq = Number(first.seq);
  let bytes = Number(first.rowBytes);
  for (const size of sizes.slice(1)) {
    bytes += Number(size.rowBytes);
    if (bytes > limit.maxBytes) break;

    lastSeq = Number(size.seq);
  }

  const query = buildLoadReplayQuery(since, scope, { throughSeq: lastSeq });

  return sql
    .exec<ReplayRow>(query.sql, ...query.params)
    .toArray()
    .map(toReplayRow);
}

/** The highest seq of any stored replay row, or 0 when there is none. */
export function maxReplaySeq(sql: Pick<SQLProvider, 'exec'>): number {
  const row = sql.exec<{ m: number | null }>('SELECT MAX(seq) AS m FROM __livething_replay').one();
  return row?.m == null ? 0 : Number(row.m);
}
