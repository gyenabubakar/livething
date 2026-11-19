import {
  assertSynchronousResult,
  AwarenessRefused,
  LiveThingConfigError,
  utf8ByteLength,
} from '@livething/core';
import { connectionCall, runDetached, withCallContext } from '~/_engine/async-context.ts';
import { channelRuntime, dispatchRuntime } from '~/_engine/engine.deps.ts';
import {
  withInvocationScope,
  withInvocationScopeSync,
} from '~/_engine/runtime/invocation-scope.ts';
import { createChannelMembershipKey } from '~/channel/runtime.ts';
import { broadcastToChannel } from '~/outgoing/runtime.ts';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { EngineCore } from '~/_engine/core.ts';
import type { StoredAwarenessEntry } from '~/_engine/runtime/connection-store.ts';
import type * as Protocol from '~/_engine/runtime/protocol.ts';
import type { ResolvedChannel, RuntimeConnection } from '~/_engine/runtime/types.ts';

/** A channel's resolved `awareness` options. */
export interface AwarenessOptions {
  state: StandardSchemaV1;
  check?: (ctx: never, state: never, previous: never) => unknown;
  windowMs: number;
  maxBytes: number;
}

/** One connection's state in one channel, as the server sends it. */
interface AwarenessEntryView {
  connectionId: string;
  memberId: string;
  meta: Record<string, unknown>;
  state: unknown;
  updatedAt: number;
}

/** `ctx.channel.awareness`. `set` is left out inside the awareness `check`. */
interface AwarenessSurface {
  list(): AwarenessEntryView[];
  get(connectionId: string): AwarenessEntryView | null;
  set?(connectionId: string, state: unknown): void;
}

type RefusalReason = 'too-large' | 'invalid' | 'check' | 'error';

/** The engine's awareness runtime: one per engine core, made when a channel first lists `awareness()`. */
export interface AwarenessRuntime {
  /** The `awareness` metadata of `__subscribeOk__`, or `undefined` for a channel without it. */
  limit(definitionKey: string): { maxBytes: number } | undefined;
  /** The largest `__awarenessSet__` frame worth parsing, in bytes. */
  readonly maxFrameBytes: number;
  /** Send a new member every state in the channel. Runs right after its member sync. */
  joined(connection: RuntimeConnection, scope: ChannelScope): void;
  /** Clear a leaving member's state. Runs right after its membership is removed. */
  left(connection: RuntimeConnection, scope: ChannelScope): void;
  /** Take a client's `__awarenessSet__`. `false` when the channel has no `awareness()`. */
  receive(connection: RuntimeConnection, frame: Protocol.AwarenessSetFrame, size: number): boolean;
  surface(scope: ChannelScope, options: { canSet: boolean }): AwarenessSurface;
  /** The `awareness` column of the connection's hibernation row. */
  stored(connection: RuntimeConnection): Record<string, StoredAwarenessEntry>;
  /** Put back a woken connection's states, in the channels it is still a member of. */
  restore(
    connection: RuntimeConnection,
    stored: Readonly<Record<string, StoredAwarenessEntry>>,
  ): void;
  /** Clear every state of a connection whose wake failed, so peers drop what they saw before the sleep. */
  forget(connection: RuntimeConnection): void;
  close(): void;
}

interface ChannelScope {
  channelName: string;
  channelFamily: string | null;
}

interface Entry {
  /** The state's JSON: what is stored, sent and read back. */
  json: string;
  memberId: string;
  /** `meta` when the state appeared, as JSON. */
  metaJson: string;
  updatedAt: number;
  /** Whether a sent change carried `meta`, so peers know this connection. */
  announced: boolean;
  /** UTF-8 bytes of `json` and `metaJson`, for the per-connection limit. */
  bytes: number;
}

interface Pending {
  state: Record<string, unknown> | null;
  /** The membership the update was sent in: a leave and rejoin makes a new one. */
  membership: unknown;
}

interface Outgoing {
  seq: number;
  connection: RuntimeConnection;
  /** `null` for a clear. */
  entry: Entry | null;
}

interface ChannelRecord {
  scope: ChannelScope;
  definitionKey: string;
  key: string;
  options: AwarenessOptions;
  entries: Map<RuntimeConnection, Entry>;
  pendingIn: Map<RuntimeConnection, Pending>;
  pendingOut: Map<RuntimeConnection, Outgoing>;
  /** The batch sequence each member that joined during the window was synced at. */
  starts: Map<RuntimeConnection, number>;
  seq: number;
  /** Set while a window is open. */
  timer: ReturnType<typeof setTimeout> | undefined;
  running: boolean;
}

const HEADER_ROOM = 4096;
const MAX_PIECE_BYTES = 256 * 1024;
const MAX_CONNECTION_BYTES = 1024 * 1024;
/** How long a change waits before the hibernation row is written: at most one write per 5 s. */
const PERSIST_DELAY_MS = 5000;

/** A state that passed the schema and the size check, with its JSON. */
interface PreparedState {
  json: string;
}

/** A `check` or schema that threw while handling one connection's update. */
interface CheckFailure {
  connection: RuntimeConnection;
  /** The membership the update was sent in. */
  membership: unknown;
  error: unknown;
}

/** One frame for a channel's members. */
interface AwarenessFrame {
  event: '__awareness__' | '__awarenessSync__';
  payloadJson: string;
}

/** What the sync entry and the size checks need of an entry. */
type EntryJson = Pick<Entry, 'memberId' | 'metaJson' | 'json'>;

type Prepared =
  | ({ ok: true } & PreparedState)
  | { ok: false; reason: 'error'; error: unknown }
  | { ok: false; reason: Exclude<RefusalReason, 'error'> };

export function createAwarenessRuntime(
  core: EngineCore,
  options: ReadonlyMap<string, AwarenessOptions>,
): AwarenessRuntime {
  const records = new Map<string, ChannelRecord>();
  const persistTimers = new Map<RuntimeConnection, ReturnType<typeof setTimeout>>();
  function deps() {
    return channelRuntime(core);
  }

  function pieceBytes(): number {
    return Math.min(Math.floor(core.messageLimits.sendBytes / 2), MAX_PIECE_BYTES);
  }

  function existingRecord(scope: ChannelScope): ChannelRecord | undefined {
    return records.get(createChannelMembershipKey(scope.channelName, scope.channelFamily));
  }

  function recordFor(scope: ChannelScope): ChannelRecord | undefined {
    const existing = existingRecord(scope);
    if (existing) return existing;

    const key = createChannelMembershipKey(scope.channelName, scope.channelFamily);

    const definitionKey = scope.channelFamily ?? scope.channelName;
    const channelOptions = options.get(definitionKey);
    if (!channelOptions) return undefined;

    const record: ChannelRecord = {
      scope: { channelName: scope.channelName, channelFamily: scope.channelFamily },
      definitionKey,
      key,
      options: channelOptions,
      entries: new Map(),
      pendingIn: new Map(),
      pendingOut: new Map(),
      starts: new Map(),
      seq: 0,
      timer: undefined,
      running: false,
    };

    records.set(key, record);

    return record;
  }

  function forgetIfIdle(record: ChannelRecord): void {
    if (
      record.entries.size === 0 &&
      record.pendingIn.size === 0 &&
      record.pendingOut.size === 0 &&
      record.timer === undefined &&
      !record.running
    ) {
      records.delete(record.key);
    }
  }

  function routing(record: ChannelScope): Record<string, unknown> {
    return { channel: record.channelName, channelFamily: record.channelFamily };
  }

  function sameMembership(
    record: ChannelRecord,
    connection: RuntimeConnection,
    membership: unknown,
  ) {
    return !connection.closing && connection.channelMemberships.get(record.key) === membership;
  }

  function refuse(record: ChannelRecord, connection: RuntimeConnection, reason: RefusalReason) {
    const error = AwarenessRefused({ event: '__awarenessSet__', reason });
    deps().sendProtocolMessage(connection, {
      event: '__error__',
      payload: { code: error.code, detail: error.detail },
      livething: routing(record.scope),
    });
  }

  /** Report a thrown `check` through `onError`, then refuse with `error` if the sender is still there. */
  function reportError(record: ChannelRecord, failure: CheckFailure): void {
    const { connection, membership } = failure;
    // The hooks get their own scope: this run's scope flushes before their first `await` returns.
    void runDetached(core.asyncContext, () =>
      withInvocationScope(core, () =>
        deps().handleRuntimeError(connection, {
          error: failure.error,
          event: '__awarenessSet__',
          routing: routing(record.scope),
          clientGets: 'awareness-refused (reason: error)',
          deliver: (target) => {
            if (sameMembership(record, target, membership)) refuse(record, target, 'error');
          },
        }),
      ),
    ).catch((reportFailure: unknown) => {
      core.logger.error('[livething] reporting an awareness check error failed', {
        channel: record.scope.channelName,
        error: reportFailure,
      });
    });
  }

  /** Run the schema and the size check: the steps a server `set()` shares with a client update. */
  function prepare(record: ChannelRecord, state: unknown): Prepared {
    let result: StandardSchemaV1.Result<unknown>;
    try {
      result = assertSynchronousResult(
        record.options.state['~standard'].validate(state),
        `awareness state of channel '${record.definitionKey}'`,
        'validator',
      );
    } catch (error) {
      // An async schema or one that throws is a server bug, not a bad state.
      return { ok: false, reason: 'error', error };
    }

    if (result.issues !== undefined) return { ok: false, reason: 'invalid' };

    let json: string | undefined;
    try {
      json = JSON.stringify(result.value);
    } catch {
      return { ok: false, reason: 'invalid' };
    }

    // Only the JSON is stored and sent, so its root must be an object too: a `toJSON` can
    // turn a plain object into a string or an array.
    if (typeof json !== 'string' || !isPlainObject(result.value) || !json.startsWith('{')) {
      return { ok: false, reason: 'invalid' };
    }

    if (utf8ByteLength(json) > record.options.maxBytes) return { ok: false, reason: 'too-large' };

    return { ok: true, json };
  }

  /** Every byte of state this connection holds, in every channel. */
  function connectionBytes(connection: RuntimeConnection, except: ChannelRecord): number {
    let total = 0;
    for (const key of connection.channelMemberships.keys()) {
      const record = records.get(key);
      if (record === except) continue;

      total += record?.entries.get(connection)?.bytes ?? 0;
    }

    return total;
  }

  /**
   * Store a prepared state. Returns a refusal reason, or `undefined` when it was stored or
   * changed nothing.
   */
  function store(
    record: ChannelRecord,
    connection: RuntimeConnection,
    prepared: PreparedState,
  ): RefusalReason | undefined {
    const entry = record.entries.get(connection);
    if (entry?.json === prepared.json) return undefined;

    let metaJson = entry?.metaJson;
    if (metaJson === undefined) {
      try {
        metaJson = JSON.stringify(connection.meta ?? {});
      } catch (error) {
        core.logger.error('[livething] a connection meta could not become JSON for awareness', {
          connectionId: connection.id,
          error,
        });
        return 'error';
      }
    }

    const memberId = memberIdOf(record, connection);
    if (entryBytes(connection.id, { memberId, metaJson, json: prepared.json }) > pieceBytes()) {
      core.logger.error('[livething] an awareness entry is too large to send; meta is too large', {
        connectionId: connection.id,
        channel: record.scope.channelName,
      });
      return 'error';
    }

    const bytes = utf8ByteLength(prepared.json) + utf8ByteLength(metaJson);
    if (connectionBytes(connection, record) + bytes > MAX_CONNECTION_BYTES) return 'too-large';

    const updatedAt = Date.now();
    if (entry) {
      entry.json = prepared.json;
      entry.updatedAt = updatedAt;
      entry.bytes = bytes;
      enqueue(record, connection, entry);
    } else {
      const created: Entry = {
        json: prepared.json,
        memberId,
        metaJson,
        updatedAt,
        announced: false,
        bytes,
      };

      record.entries.set(connection, created);
      enqueue(record, connection, created);
    }

    return undefined;
  }

  function clear(record: ChannelRecord, connection: RuntimeConnection): void {
    if (!record.entries.delete(connection)) return;

    enqueue(record, connection, null);
  }

  function enqueue(record: ChannelRecord, connection: RuntimeConnection, entry: Entry | null) {
    record.seq += 1;
    record.pendingOut.set(connection, { seq: record.seq, connection, entry });
    schedulePersist(connection);
  }

  /**
   * Write the hibernation row later, not on each change. The pending timer keeps a Durable
   * Object awake until the write is done.
   */
  function schedulePersist(connection: RuntimeConnection): void {
    if (!connection.survivesHibernation || connection.closing || persistTimers.has(connection)) {
      return;
    }

    const timer = runDetached(core.asyncContext, () =>
      setTimeout(() => {
        persistTimers.delete(connection);
        try {
          deps().persistAttachment(connection);
        } catch (error) {
          // The failed write already closed the connection; nothing here can throw further.
          core.logger.error('[livething] writing awareness state for hibernation failed', {
            connectionId: connection.id,
            error,
          });
        }
      }, PERSIST_DELAY_MS),
    );
    (timer as { unref?: () => void }).unref?.();
    persistTimers.set(connection, timer);
  }

  function cancelPersist(connection: RuntimeConnection): void {
    clearTimeout(persistTimers.get(connection));
    persistTimers.delete(connection);
  }

  function memberIdOf(record: ChannelRecord, connection: RuntimeConnection): string {
    return core.isChannelDurable(record.definitionKey) && connection.userId !== ''
      ? connection.userId
      : connection.id;
  }

  /** Handle one client update: the table in the spec, 6.3. */
  function accept(record: ChannelRecord, connection: RuntimeConnection, pending: Pending): void {
    if (!sameMembership(record, connection, pending.membership)) return;

    if (pending.state === null) {
      clear(record, connection);
      return;
    }

    const prepared = prepare(record, pending.state);
    if (!prepared.ok) {
      if (prepared.reason === 'error') {
        reportError(record, { connection, membership: pending.membership, error: prepared.error });
      } else {
        refuse(record, connection, prepared.reason);
      }

      return;
    }

    const entry = record.entries.get(connection);
    if (entry?.json === prepared.json) return;

    const { check } = record.options;
    if (check) {
      let allowed: unknown;
      try {
        allowed = assertSynchronousResult(
          check(
            checkContext(record, connection) as never,
            // Copies, so a `check` that changes them cannot change what is stored.
            JSON.parse(prepared.json) as never,
            (entry ? JSON.parse(entry.json) : null) as never,
          ),
          `awareness check of channel '${record.definitionKey}'`,
        );
        if (typeof allowed !== 'boolean') {
          throw new LiveThingConfigError(
            `the awareness check of channel '${record.definitionKey}' must return true or false.`,
          );
        }
      } catch (error) {
        // `check` is app code: it may have kicked or closed its own sender.
        if (sameMembership(record, connection, pending.membership)) {
          reportError(record, { connection, membership: pending.membership, error });
        }

        return;
      }

      if (!sameMembership(record, connection, pending.membership)) return;

      if (!allowed) {
        refuse(record, connection, 'check');
        return;
      }
    }

    const refused = store(record, connection, prepared);
    if (refused) refuse(record, connection, refused);
  }

  function resolvedScope(record: ChannelRecord): ResolvedChannel {
    const { channelName, channelFamily } = record.scope;
    const channel =
      channelFamily === null
        ? core.compiled.channels.get(channelName)
        : core.compiled.channelFamilies.get(channelFamily);

    return { channel, channelName, channelFamily };
  }

  function checkContext(record: ChannelRecord, connection: RuntimeConnection): unknown {
    return deps().buildConnectionContext(connection, {
      ...resolvedScope(record),
      isAwarenessCheck: true,
    } as ResolvedChannel);
  }

  function takeIncoming(record: ChannelRecord): void {
    const scope = resolvedScope(record);
    for (const [connection, pending] of record.pendingIn) {
      record.pendingIn.delete(connection);
      try {
        withInvocationScopeSync(core, () =>
          withCallContext(
            core.asyncContext,
            connectionCall(connection.id, scope, () =>
              deps().buildConnectionContext(connection, scope),
            ),
            () => accept(record, connection, pending),
          ),
        );
      } catch (error) {
        core.logger.error('[livething] an awareness update failed', {
          channel: record.scope.channelName,
          connectionId: connection.id,
          error,
        });
      }
    }
  }

  /** Send the waiting changes. Returns whether there were any. */
  function sendOut(record: ChannelRecord): boolean {
    if (record.pendingOut.size === 0) return false;

    const outgoing = [...record.pendingOut.values()].sort((a, b) => a.seq - b.seq);
    const starts = record.starts;
    record.pendingOut = new Map();
    record.starts = new Map();

    // A cursor must never reach a member before the join of the connection it belongs to.
    if (outgoing.some((item) => item.entry !== null && !item.entry.announced)) {
      core.presenceBatcher?.flush(record.scope.channelName, record.scope.channelFamily);
    }

    const changes = outgoing.map((item) => ({
      seq: item.seq,
      json: changeJson(item.connection, item.entry),
    }));
    for (const { entry } of outgoing) if (entry) entry.announced = true;

    const groups = new Map<number, RuntimeConnection[]>();
    for (const member of core.channelMembers.get(record.key) ?? []) {
      const start = starts.get(member) ?? 0;
      const group = groups.get(start);
      if (group) group.push(member);
      else groups.set(start, [member]);
    }

    for (const [start, recipients] of groups) {
      const visible = changes.filter((change) => change.seq > start).map((change) => change.json);
      for (const piece of pieces(visible)) {
        broadcast(
          record,
          { event: '__awareness__', payloadJson: `{"changes":[${piece.join(',')}]}` },
          recipients,
        );
      }
    }

    return true;
  }

  function changeJson(connection: RuntimeConnection, entry: Entry | null): string {
    const id = JSON.stringify(connection.id);
    if (!entry) return `{"connectionId":${id},"state":null}`;

    const meta = entry.announced ? '' : `,"meta":${entry.metaJson}`;

    return `{"connectionId":${id},"memberId":${JSON.stringify(entry.memberId)}${meta},"state":${entry.json}}`;
  }

  /** Split JSON items into groups that fit one frame each. Every group has at least one item. */
  function pieces(items: string[]): string[][] {
    if (items.length === 0) return [];

    const limit = pieceBytes() - HEADER_ROOM;
    const groups: string[][] = [[]];
    let size = 0;
    for (const item of items) {
      const bytes = utf8ByteLength(item) + 1;
      const current = groups.at(-1)!;
      if (current.length > 0 && size + bytes > limit) {
        groups.push([item]);
        size = bytes;
      } else {
        current.push(item);
        size += bytes;
      }
    }

    return groups;
  }

  function broadcast(
    record: ChannelRecord,
    frame: AwarenessFrame,
    recipients: RuntimeConnection[],
  ): void {
    broadcastToChannel(dispatchRuntime(core), {
      channelName: record.scope.channelName,
      channelFamily: record.scope.channelFamily,
      event: frame.event,
      payload: null,
      payloadJson: frame.payloadJson,
      excludeConnectionId: undefined,
      recipients,
    });
  }

  /** Run a window now: the waiting updates, then the waiting changes. Opens the next window. */
  function runWindow(record: ChannelRecord): void {
    record.running = true;
    // A refused or unchanged update also opens a window, so `check` runs at most once per window.
    const took = record.pendingIn.size > 0;
    let sent = false;
    try {
      takeIncoming(record);
      sent = sendOut(record);
    } catch (error) {
      core.logger.error('[livething] an awareness window failed', {
        channel: record.scope.channelName,
        channelFamily: record.scope.channelFamily,
        error,
      });
    } finally {
      record.running = false;
    }

    if (took || sent || record.pendingOut.size > 0 || record.pendingIn.size > 0) {
      armWindow(record, record.options.windowMs);
      return;
    }

    record.timer = undefined;
    record.starts.clear();
    forgetIfIdle(record);
  }

  function armWindow(record: ChannelRecord, delayMs: number): void {
    record.timer = setTimeout(
      () =>
        runDetached(core.asyncContext, () => {
          record.timer = undefined;
          runWindow(record);
        }),
      delayMs,
    );
    (record.timer as { unref?: () => void }).unref?.();
  }

  /** Start a run at once when no window is open; otherwise the open window takes the work. */
  function wake(record: ChannelRecord): void {
    if (record.timer !== undefined || record.running) return;

    runWindow(record);
  }

  function entryBytes(connectionId: string, entry: EntryJson) {
    return utf8ByteLength(syncEntryHead(connectionId, entry)) + 32;
  }

  function syncEntryHead(connectionId: string, entry: EntryJson) {
    return `{"connectionId":${JSON.stringify(connectionId)},"memberId":${JSON.stringify(entry.memberId)},"meta":${entry.metaJson},"state":${entry.json}`;
  }

  function view(connection: RuntimeConnection, entry: Entry): AwarenessEntryView {
    return {
      connectionId: connection.id,
      memberId: entry.memberId,
      // Copies: app code that changes them must not change what is stored and sent.
      meta: JSON.parse(entry.metaJson) as Record<string, unknown>,
      state: JSON.parse(entry.json) as unknown,
      updatedAt: entry.updatedAt,
    };
  }

  return {
    // Read when used: channels add their options while the server sets up.
    get maxFrameBytes() {
      let largest = 0;
      for (const channelOptions of options.values()) {
        largest = Math.max(largest, channelOptions.maxBytes + HEADER_ROOM);
      }

      return largest;
    },

    limit(definitionKey) {
      const channelOptions = options.get(definitionKey);
      return channelOptions ? { maxBytes: channelOptions.maxBytes } : undefined;
    },

    joined(connection, scope) {
      const record = recordFor(scope);
      if (!record) return;

      const now = Date.now();
      const items: string[] = [];
      for (const [member, entry] of record.entries) {
        if (member === connection) continue;

        const head = syncEntryHead(member.id, entry);
        items.push(`${head},"ageMs":${Math.max(0, now - entry.updatedAt)}}`);
      }

      const groups = pieces(items);
      if (groups.length === 0) groups.push([]);

      groups.forEach((group, index) => {
        const more = index < groups.length - 1 ? ',"more":true' : '';
        broadcast(
          record,
          { event: '__awarenessSync__', payloadJson: `{"entries":[${group.join(',')}]${more}}` },
          [connection],
        );
      });

      record.starts.set(connection, record.seq);
      forgetIfIdle(record);
    },

    left(connection, scope) {
      const key = createChannelMembershipKey(scope.channelName, scope.channelFamily);
      const record = records.get(key);
      if (record) {
        record.pendingIn.delete(connection);
        record.starts.delete(connection);
        if (record.entries.has(connection)) {
          clear(record, connection);
          wake(record);
        } else {
          forgetIfIdle(record);
        }
      }

      // `leaveChannel` writes the whole row right after this, so a timed write is not needed.
      cancelPersist(connection);
    },

    receive(connection, frame, size) {
      const { channel, channelFamily } = frame.__livething;
      const scope = { channelName: channel, channelFamily };
      const key = createChannelMembershipKey(channel, channelFamily);
      const membership = connection.channelMemberships.get(key);
      if (membership === undefined) return true;

      const record = recordFor(scope);
      if (!record) return false;

      if (size > record.options.maxBytes + HEADER_ROOM) {
        record.pendingIn.delete(connection);
        refuse(record, connection, 'too-large');
        forgetIfIdle(record);
        return true;
      }

      record.pendingIn.set(connection, { state: frame.payload.state, membership });
      wake(record);

      return true;
    },

    surface(scope, surfaceOptions) {
      const surface: AwarenessSurface = {
        // Reads look up without creating: a record made here would never be forgotten.
        list() {
          const record = existingRecord(scope);
          return record ? [...record.entries].map((pair) => view(...pair)) : [];
        },
        get(connectionId) {
          const record = existingRecord(scope);
          const connection = core.connections.get(connectionId);
          const entry = connection && record?.entries.get(connection);

          return entry ? view(connection, entry) : null;
        },
      };

      if (surfaceOptions.canSet) {
        surface.set = (connectionId, state) => {
          const record = recordFor(scope);
          const connection = core.connections.get(connectionId);
          if (!record || !connection?.channelMemberships.has(record.key)) {
            throw new Error(
              `[livething] awareness.set: connection '${connectionId}' is not a member of channel '${scope.channelName}'.`,
            );
          }

          if (state === null) {
            record.pendingIn.delete(connection);
            clear(record, connection);
            wake(record);
            return;
          }

          const prepared = prepare(record, state);
          if (!prepared.ok) {
            if (prepared.reason === 'error') throw prepared.error;

            throw new Error(
              `[livething] awareness.set: the state was refused (${prepared.reason}) for channel '${scope.channelName}'.`,
            );
          }

          const refused = store(record, connection, prepared);
          if (refused) {
            throw new Error(
              `[livething] awareness.set: the state was refused (${refused}) for channel '${scope.channelName}'.`,
            );
          }

          record.pendingIn.delete(connection);
          wake(record);
        };
      }

      return surface;
    },

    stored(connection) {
      const stored: Record<string, StoredAwarenessEntry> = {};
      for (const key of connection.channelMemberships.keys()) {
        const entry = records.get(key)?.entries.get(connection);
        if (entry) {
          stored[key] = { state: entry.json, meta: entry.metaJson, updatedAt: entry.updatedAt };
        }
      }

      return stored;
    },

    restore(connection, stored) {
      for (const [key, membership] of connection.channelMemberships) {
        const saved = stored[key];
        const record = saved && recordFor(membership);
        if (!record) continue;

        // A redeploy may have changed the schema or lowered `maxBytes` while the object slept.
        const prepared = prepare(record, parseJson(saved.state));
        if (!prepared.ok || !isPlainObject(parseJson(saved.meta))) {
          // Peers saw this entry before the sleep. Clear it after the restore pass, so the
          // peers woken later in the same pass get the clear too.
          enqueue(record, connection, null);
          if (record.timer === undefined && !record.running) armWindow(record, 0);
          continue;
        }

        // Peers got this entry, with its meta, before the object slept.
        record.entries.set(connection, {
          json: prepared.json,
          memberId: memberIdOf(record, connection),
          metaJson: saved.meta,
          updatedAt: saved.updatedAt,
          announced: true,
          bytes: utf8ByteLength(prepared.json) + utf8ByteLength(saved.meta),
        });
      }
    },

    forget(connection) {
      for (const record of [...records.values()]) {
        record.pendingIn.delete(connection);
        record.starts.delete(connection);
        if (!record.entries.has(connection)) continue;

        clear(record, connection);
        wake(record);
      }

      cancelPersist(connection);
    },

    close() {
      for (const record of records.values()) clearTimeout(record.timer);
      for (const timer of persistTimers.values()) clearTimeout(timer);
      records.clear();
      persistTimers.clear();
    },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;

  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Parse JSON read back from storage; `undefined` when it is broken. */
function parseJson(json: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return undefined;
  }
}
