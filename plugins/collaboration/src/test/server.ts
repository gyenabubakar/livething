import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseSync } from 'node:sqlite';
import { encodeBinaryFrame, splitBinaryFrame } from '@livething/core';
import { server } from '@livething/server';
import {
  adapter,
  rejectAsyncTransactionCallback,
  rejectAsyncTransactionResult,
} from '@livething/server/adapters';
import { channels } from '@livething/server/channels';
import { PLUGIN_ID } from '~/doc/wire.ts';
import { collaboration } from '~/server/plugin.ts';
import { taskBoard } from '~/test/task-board.ts';
import type { InferClient, SQLProvider, SqlResult } from '@livething/server';
import type { Engine, KVProvider, TransportFrame } from '@livething/server/adapters';
import type { CollaborationApi, CollaborationOptions, DocAccess } from '~/server/plugin.ts';

const docs = [taskBoard] as const;
type Docs = typeof docs;

const FAMILY = `__${PLUGIN_ID}::docs`;
const PREFIX = `__${PLUGIN_ID}::`;

/** A real in-memory SQLite behind the `SQLProvider` contract, with a small row limit. */
export function testSql(maxValueBytes = 1_000_000): SQLProvider & { db: DatabaseSync } {
  const db = new DatabaseSync(':memory:');

  function exec<TRow>(query: string, ...params: unknown[]): SqlResult<TRow> {
    const trimmed = query.trim();
    if (/^(SELECT|WITH|PRAGMA)/i.test(trimmed)) {
      const rows = db.prepare(trimmed).all(...(params as never[])) as TRow[];
      return {
        toArray: () => rows,
        one: () => rows[0] ?? null,
        raw: () => rows.map((row) => Object.values(row as object)),
      };
    }

    // A schema batch runs its leading statements bare and binds the params to the last one.
    const statements = trimmed
      .split(';')
      .map((statement) => statement.trim())
      .filter(Boolean);
    const last = statements.pop()!;
    for (const statement of statements) db.exec(statement);
    db.prepare(last).run(...(params as never[]));

    return { toArray: () => [], one: () => null, raw: () => [] };
  }

  let depth = 0;

  return {
    db,
    exec,
    limits: { maxBoundParams: 32_766, maxStatementBytes: 1_000_000_000, maxValueBytes },
    transaction(fn) {
      rejectAsyncTransactionCallback(fn);
      const savepoint = `sp${depth}`;
      db.exec(`SAVEPOINT ${savepoint}`);
      depth += 1;
      try {
        const result = fn();
        rejectAsyncTransactionResult(result);
        db.exec(`RELEASE ${savepoint}`);
        return result;
      } catch (cause) {
        db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
        throw cause;
      } finally {
        depth -= 1;
      }
    },
  };
}

export function testKv(): KVProvider {
  const store = new Map<string, unknown>();
  return {
    get: async (key) => store.get(key),
    set: async (key, value) => void store.set(key, value),
    delete: async (key) => void store.delete(key),
    list: async (prefix) => [...store.keys()].filter((key) => !prefix || key.startsWith(prefix)),
  };
}

export interface HarnessOptions extends Partial<CollaborationOptions<Docs>> {
  readonly hibernation?: boolean;
  readonly sql?: SQLProvider & { db: DatabaseSync };
  /** The server's key-value store: pass one in to keep it for the next server, as `sql`. */
  readonly kv?: KVProvider;
  /** The largest frame the server may send. Default: the engine's 32 MiB. */
  readonly sendBytes?: number;
  /** The largest frame the server takes, as a Node host can raise it. Default: 32 MiB. */
  readonly receiveBytes?: number;
}

/** Every user can edit, except a guest, who views, and an outsider, who is refused. */
const ACCESS: Record<string, DocAccess> = { u_guest: 'view', u_out: false };

/** Huddle's server definition: channels and the Collaboration plugin. */
function huddleDefinition(
  options: Omit<HarnessOptions, 'sql' | 'kv' | 'sendBytes' | 'receiveBytes'>,
) {
  const { hibernation, ...pluginOptions } = options;
  const Collaboration = collaboration({
    docs,
    access: (ctx) => ACCESS[ctx.user.id ?? ''] ?? 'edit',
    saveDelayMs: 10,
    ...pluginOptions,
  });

  return server({
    authenticate: () => ({}),
    ...(hibernation ? { hibernation: true } : {}),
    capabilities: [channels(), Collaboration()],
  }).assemble({ handlers: [] });
}

/** What a Huddle client may use. */
export type HuddleClient = InferClient<ReturnType<typeof huddleDefinition>>;

/** A running server with the Collaboration plugin for Huddle's task board. */
export async function startServer(options: HarnessOptions = {}) {
  const { hibernation, sql = testSql(), kv = testKv(), sendBytes, receiveBytes } = options;
  const definition = huddleDefinition(options);

  const logged: unknown[][] = [];
  let engine!: Engine;
  // A durable alarm, as the Node adapter keeps it: one timer that runs the due tasks.
  let alarm: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const timers = {
    async setAlarm(time: number) {
      clearTimeout(alarm);
      if (stopped) return;

      alarm = setTimeout(() => void engine.handleAlarm(), Math.max(0, time - Date.now()));
    },
    async deleteAlarm() {
      clearTimeout(alarm);
    },
  };

  adapter({
    id: 'collaboration-spec',
    asyncContextFactory: <TStore>() => new AsyncLocalStorage<TStore>(),
    ...(hibernation
      ? {
          // Like a Cloudflare socket attachment: the snapshot lives on the socket.
          hibernation: {
            persist: (socket: unknown, snapshot: unknown) => {
              (socket as { attachment?: unknown }).attachment = snapshot;
            },
            restore: (socket: unknown) => (socket as { attachment?: unknown }).attachment,
          },
        }
      : {}),
    setup(createEngine) {
      engine = createEngine({
        storage: { sql, kv },
        ...(sendBytes || receiveBytes
          ? {
              messageLimits: {
                receiveBytes: receiveBytes ?? 32 * 1024 * 1024,
                sendBytes: sendBytes ?? 32 * 1024 * 1024,
              },
            }
          : {}),
        timers,
        platform: {},
        logger: { info: () => {}, warn: () => {}, error: (...args) => logged.push(args) },
      });
      return {};
    },
  })(definition, undefined as never);
  await engine.initialize();

  function api(): CollaborationApi<Docs> {
    return (engine.admin() as unknown as { plugin(id: string): CollaborationApi<Docs> }).plugin(
      PLUGIN_ID,
    );
  }

  /**
   * Drop the server with no shutdown, as Cloudflare evicts a Durable Object: what is in memory
   * is gone, and only storage is left for the next server on the same `sql`.
   */
  function evict(): void {
    stopped = true;
    clearTimeout(alarm);
  }

  return { engine, sql, logged, api, evict };
}

/** Let the server finish what it is doing. */
export function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** One frame the server sent: its event (without the plugin prefix), info, metadata and bytes. */
interface Sent {
  readonly event: string;
  readonly info: unknown;
  readonly metadata: Record<string, unknown> | null;
  readonly bytes?: Uint8Array;
}

function routing(id: string, exchange?: string) {
  return {
    channel: { name: `task-board:${id}`, family: FAMILY },
    ...(exchange ? { exchange: { id: exchange, source: 'client' } } : {}),
  };
}

/** A client on the server, speaking the plugin's wire protocol by hand. */
export async function connect(engine: Engine, userId: string, socketKey: unknown = Symbol(userId)) {
  await engine.initialize();
  const sent: Sent[] = [];
  let connectionId = '';
  let exchanges = 0;
  const handle = engine.accept(socketKey, {
    send(frame: TransportFrame) {
      if (frame.kind === 'text') {
        const [event, info, metadata] = JSON.parse(frame.text) as [string, unknown, never];
        if (event === '__connected__') {
          connectionId = (info as { connectionId: string }).connectionId;
        }

        sent.push({ event: event.replace(PREFIX, ''), info, metadata });
        return;
      }

      const split = splitBinaryFrame(frame.bytes);
      if (split.kind !== 'frame') throw new Error('the server sent a broken binary frame');

      const [event, info, metadata] = JSON.parse(split.envelope) as [string, unknown, never];
      sent.push({ event: event.replace(PREFIX, ''), info, metadata, bytes: split.bytes.slice() });
    },
    close: () => {},
    bufferedAmount: () => 0,
    userId,
    survivesHibernation: true,
  });

  await settle();

  function answerTo(exchange: string) {
    return sent.find(
      (frame) =>
        frame.event !== '__error__' &&
        (frame.metadata?.exchange as { id?: string } | undefined)?.id === exchange,
    );
  }

  async function binary(
    envelope: [event: string, info: unknown, metadata: unknown],
    bytes: Uint8Array,
  ) {
    const [event, info, metadata] = envelope;
    await handle.handleBinaryMessage(
      encodeBinaryFrame(JSON.stringify([PREFIX + event, info, metadata]), bytes),
    );
    await settle();
  }

  return {
    handle,
    sent,
    get id() {
      return connectionId;
    },
    of: (event: string) => sent.filter((frame) => frame.event === event),
    errors: () =>
      sent
        .filter((frame) => frame.event === '__error__')
        .map((frame) => {
          const info = frame.info as { code: string; detail?: unknown };
          return { ...info, code: info.code.replace(PREFIX, '') };
        }),
    async open(id: string) {
      await handle.handleMessage(JSON.stringify(['__subscribe__', {}, routing(id)]));
      await settle();
    },
    async leave(id: string) {
      await handle.handleMessage(JSON.stringify(['__unsubscribe__', null, routing(id)]));
      await settle();
    },
    /** Ask for what the server has that `vector` does not. */
    async sync(id: string, vector: Uint8Array) {
      exchanges += 1;
      const exchange = `sync-${exchanges}`;
      await binary(['sync', null, routing(id, exchange)], vector);
      return answerTo(exchange);
    },
    /** Send a JSON request on a doc's room, and give the answer, if one came. */
    async request(id: string, event: string, payload: unknown) {
      exchanges += 1;
      const exchange = `request-${exchanges}`;
      await handle.handleMessage(JSON.stringify([PREFIX + event, payload, routing(id, exchange)]));
      await settle();

      return answerTo(exchange);
    },
    /** Send a binary request with no bytes on a doc's room, and give the answer, if one came. */
    async binaryRequest(id: string, event: string, info: unknown) {
      exchanges += 1;
      const exchange = `binary-${exchanges}`;
      await binary([event, info, routing(id, exchange)], new Uint8Array(0));
      return answerTo(exchange);
    },
    update: (id: string, info: unknown, bytes: Uint8Array) =>
      binary(['update', info, routing(id)], bytes),
    async aware(id: string, state: unknown) {
      await handle.handleMessage(JSON.stringify(['__awarenessSet__', { state }, routing(id)]));
      // Awareness takes changes in 50 ms windows.
      await new Promise((resolve) => setTimeout(resolve, 60));
    },
  };
}
