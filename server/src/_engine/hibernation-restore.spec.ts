import { adapter } from '~/_adapters/adapter.ts';
import { t } from '~/_api/definitions.ts';
import { server } from '~/_define/server.ts';
import { writeConnectionRow } from '~/_engine/runtime/connection-store.ts';
import { createTestKV, createTestSql } from '~/_test/sql.ts';
import { channels } from '~/channel/capability.ts';
import { emits } from '~/emits/emits.ts';
import * as v from 'valibot';
import { describe, expect, it, vi } from 'vitest';
import type { Engine } from '~/_engine/engine.ts';
import type { AsyncContextFactory, KVProvider, SQLProvider } from '~/context.ts';

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

function buildEngine(
  storage: { sql: SQLProvider; kv: KVProvider },
  restore: (wsKey: unknown) => unknown = (wsKey) =>
    (wsKey as { deserializeAttachment(): unknown }).deserializeAttachment(),
): Engine {
  const base = server({
    hibernation: { enabled: true },
    capabilities: [channels()],
  });
  const room = base.channel('room', {
    capabilities: [emits({ 'room-message': t<{ text: string }>() })],
  });
  const shout = room.on('shout', {
    input: v.object({ text: v.string() }),
    run(ctx, payload) {
      ctx.channel.broadcast('room-message', { text: payload.text });
    },
  });
  const definition = base.assemble({ handlers: [shout] });

  let engine!: Engine;
  const runAdapter = adapter({
    id: 'test',
    hibernation: {
      persist: () => {},
      restore,
    },
    asyncContextFactory: passthroughAsyncContext(),
    setup(createEngine) {
      engine = createEngine({
        platform: { kind: 'test' },
        storage,
        timers: {
          setAlarm: vi.fn(async () => {}),
          deleteAlarm: vi.fn(async () => {}),
          getAlarm: vi.fn(async () => null),
        },
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });
      return {};
    },
  });
  runAdapter(definition, {} as never);

  return engine;
}

describe('hibernation restore — live delivery to a passive member', () => {
  it('reaches a member hibernated at broadcast time without it sending a message first', async () => {
    const storage = { sql: createTestSql(), kv: createTestKV() };
    const engine = buildEngine(storage);
    await engine.initialize();

    // Three members of `room` survived hibernation with their rows persisted.
    const kofi = hibernatedSocket('kofi');
    const ama = hibernatedSocket('ama');
    const yaw = hibernatedSocket('yaw');
    for (const s of [kofi, ama, yaw]) {
      writeConnectionRow(storage.sql, {
        connection_id: s.id,
        user_id: s.id,
        meta: {},
        ephemeral_tags: [],
        ephemeral_memberships: [{ channelName: 'room', channelFamily: null }],
        active_stream_ids: [],
      });
    }

    await engine.restoreHibernatedConnections([kofi.ws, ama.ws, yaw.ws]);

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

  it('rejects boot restore failures instead of leaving an unobserved wake promise', async () => {
    const storage = { sql: createTestSql(), kv: createTestKV() };
    const failure = new Error('attachment restore failed');
    const engine = buildEngine(storage, () => {
      throw failure;
    });
    await engine.initialize();

    const socket = hibernatedSocket('broken');

    await expect(engine.restoreHibernatedConnections([socket.ws])).rejects.toBe(failure);
    expect(engine.core.preloadedConnectionRows).toBeUndefined();
    expect(engine.core.connections.size).toBe(0);
  });

  it('rejects an async adapter restore instead of treating its Promise as an empty snapshot', async () => {
    const storage = { sql: createTestSql(), kv: createTestKV() };
    const engine = buildEngine(storage, () => Promise.reject(new Error('async restore failed')));
    await engine.initialize();

    const socket = hibernatedSocket('async');

    await expect(engine.restoreHibernatedConnections([socket.ws])).rejects.toThrow(
      /async callbacks are not supported/,
    );
    expect(engine.core.preloadedConnectionRows).toBeUndefined();
    expect(engine.core.connections.size).toBe(0);
  });
});
