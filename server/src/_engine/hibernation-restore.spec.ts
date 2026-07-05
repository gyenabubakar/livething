import { DatabaseSync } from 'node:sqlite';
import { adapter } from '~/_adapters/define.ts';
import { t } from '~/_api/definitions.ts';
import { define } from '~/_define/define.ts';
import { writeConnectionRow } from '~/_engine/runtime/connection-store.ts';
import { channels } from '~/channel/capability.ts';
import * as v from 'valibot';
import { describe, expect, it, vi } from 'vitest';
import type { Engine } from '~/_engine/engine.ts';
import type { AsyncContextFactory, KVProvider, SQLProvider, SqlResult } from '~/context.ts';

function realSql(): SQLProvider {
  const db = new DatabaseSync(':memory:');
  function exec<TRow = unknown>(query: string, ...params: unknown[]): SqlResult<TRow> {
    const trimmed = query.trim();
    if (/^\s*(SELECT|WITH)/i.test(trimmed)) {
      const rows = db.prepare(trimmed).all(...(params as never[])) as TRow[];
      return {
        toArray: () => rows,
        one: () => rows[0] ?? null,
        raw: () => rows.map((r) => Object.values(r as Record<string, unknown>)),
      };
    }
    // A schema-init exec bundles several statements with `;`; the final one may
    // carry the params. Run the leading statements unparameterized, then bind
    // the params onto the last.
    const statements = trimmed
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    const last = statements.pop()!;
    for (const statement of statements) db.exec(statement);
    db.prepare(last).run(...(params as never[]));
    return { toArray: () => [], one: () => null, raw: () => [] };
  }
  return { exec, transaction: (fn) => fn({ exec }) };
}

function memoryKV(): KVProvider {
  const store = new Map<string, unknown>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: unknown) => void store.set(key, value),
    delete: async (key: string) => void store.delete(key),
    list: async () => ({ keys: [...store.keys()].map((name) => ({ name })) }),
  } as unknown as KVProvider;
}

function passthroughAsyncContext(): AsyncContextFactory {
  return function createAsyncContext<TStore>() {
    let current: TStore | undefined;
    return {
      run<R>(store: TStore, callback: () => R): R {
        const prev = current;
        current = store;
        try {
          return callback();
        } finally {
          current = prev;
        }
      },
      getStore: () => current,
    };
  };
}

/**
 * A socket the platform hands back after a hibernation eviction. It records the
 * frames the engine writes to it and echoes back its persisted attachment id.
 */
function hibernatedSocket(id: string) {
  const frames: string[] = [];
  return {
    id,
    frames,
    ws: {
      send: (data: string) => void frames.push(data),
      close: () => {},
      deserializeAttachment: () => ({ id }),
      serializeAttachment: () => {},
    },
  };
}

function buildEngine(storage: { sql: SQLProvider; kv: KVProvider }): Engine {
  const base = define({
    env: t<Record<string, never>>(),
    hibernation: { enabled: true },
    capabilities: [channels()],
  });
  const room = base.channel('room', {
    outgoing: { emits: { 'room-message': t<{ text: string }>() } },
  });
  const shout = room.on('shout', {
    input: v.object({ text: v.string() }),
    run(ctx, payload) {
      ctx.channel.broadcast('room-message', { text: payload.text });
    },
  });
  const handler = base.assemble(shout);

  let engine!: Engine;
  const server = adapter({
    id: 'test',
    hibernation: {
      persist: () => {},
      restore: (wsKey) => (wsKey as { deserializeAttachment(): unknown }).deserializeAttachment(),
    },
    asyncContextFactory: passthroughAsyncContext(),
    setup(createEngine) {
      engine = createEngine({
        env: {},
        platform: { kind: 'test' },
        storage,
        timers: {
          setAlarm: vi.fn(async () => {}),
          deleteAlarm: vi.fn(async () => {}),
          getAlarm: vi.fn(async () => null),
        },
        waitUntil: () => {},
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });
      return {};
    },
  });
  server(handler, {} as never);
  return engine;
}

describe('hibernation restore — live delivery to a passive member', () => {
  it('reaches a member hibernated at broadcast time without it sending a message first', async () => {
    const storage = { sql: realSql(), kv: memoryKV() };
    const engine = buildEngine(storage);
    await engine.initialize();

    // Three members of `room` survived hibernation with their rows persisted.
    const kofi = hibernatedSocket('kofi');
    const ama = hibernatedSocket('ama');
    const yaw = hibernatedSocket('yaw');
    for (const s of [kofi, ama, yaw]) {
      writeConnectionRow(storage.sql, {
        connection_id: s.id,
        identity: s.id,
        meta: {},
        ephemeral_tags: [],
        ephemeral_memberships: [{ channelName: 'room', channelFamily: null }],
        active_stream_ids: [],
      });
    }

    engine.restoreHibernatedConnections([kofi.ws, ama.ws, yaw.ws]);

    // Kofi and Ama never send a message; without eager restore their membership
    // would be missing and the broadcast would skip them.
    await engine.handleHibernationWake(yaw.ws).handleMessage(
      JSON.stringify({
        event: 'shout',
        payload: { text: 'akwaaba' },
        __wskit: { channel: 'room' },
      }),
    );

    function received(s: { frames: string[] }) {
      return s.frames.map((f) => JSON.parse(f)).find((m) => m.event === 'room-message');
    }

    expect(received(kofi)?.payload).toEqual({ text: 'akwaaba' });
    expect(received(ama)?.payload).toEqual({ text: 'akwaaba' });
  });
});
