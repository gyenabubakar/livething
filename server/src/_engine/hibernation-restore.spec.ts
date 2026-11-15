import { adapter } from '~/_adapters/adapter.ts';
import { t } from '~/_api/definitions.ts';
import { server } from '~/_define/server.ts';
import {
  buildConnectionRow,
  readConnectionRow,
  writeConnectionRow,
} from '~/_engine/runtime/connection-store.ts';
import { createTestKV, createTestSql } from '~/_test/sql.ts';
import { channels } from '~/channel/capability.ts';
import { dedup } from '~/dedup/capability.ts';
import { emits } from '~/emits/emits.ts';
import { replay } from '~/replay/capability.ts';
import { sequence } from '~/sequence/capability.ts';
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
  restore: (socketKey: unknown) => unknown = (socketKey) =>
    (socketKey as { deserializeAttachment(): unknown }).deserializeAttachment(),
  withReplay = false,
): Engine {
  const base = server({
    hibernation: true,
    capabilities: [
      channels(),
      emits({ note: t<{ text: string }>() }),
      ...(withReplay ? [dedup(), sequence({ persist: true }), replay.history()] : []),
    ],
  });
  const noteToSelf = base.on('note-to-self', {
    input: v.object({ text: v.string() }),
    run(ctx, payload) {
      ctx.send('note', { text: payload.text });
    },
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
  const definition = base.assemble({ handlers: [shout, noteToSelf] });

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
    await engine
      .handleHibernationWake(yaw.ws)
      .handleMessage(JSON.stringify(['shout', { text: 'akwaaba' }, { channel: { name: 'room' } }]));

    function received(s: { frames: string[] }) {
      return s.frames.map((f) => JSON.parse(f)).find((m) => m[0] === 'room-message');
    }

    expect(received(kofi)?.[1]).toEqual({ text: 'akwaaba' });
    expect(received(ama)?.[1]).toEqual({ text: 'akwaaba' });
  });

  it('still saves a channel join made after a wake, so the next wake restores it', async () => {
    const storage = { sql: createTestSql(), kv: createTestKV() };
    const engine = buildEngine(storage);
    await engine.initialize();

    const kofi = hibernatedSocket('kofi');
    writeConnectionRow(storage.sql, {
      connection_id: kofi.id,
      user_id: kofi.id,
      meta: {},
      ephemeral_tags: [],
      ephemeral_memberships: [],
      active_stream_ids: [],
    });
    await engine.restoreHibernatedConnections([kofi.ws]);

    await engine
      .handleHibernationWake(kofi.ws)
      .handleMessage(JSON.stringify(['__subscribe__', null, { channel: { name: 'room' } }]));

    expect(engine.core.connections.get('kofi')?.survivesHibernation).toBe(true);
    expect(readConnectionRow(storage.sql, 'kofi')?.ephemeral_memberships).toEqual([
      { channelName: 'room', channelFamily: null },
    ]);
  });

  it('saves nothing for a connection the platform does not hold while the server sleeps', async () => {
    const storage = { sql: createTestSql(), kv: createTestKV() };
    const engine = buildEngine(storage);
    await engine.initialize();

    const handle = engine.accept(Symbol('ama'), {
      send: () => true,
      close: () => {},
      bufferedAmount: () => 0,
      userId: 'ama',
    });
    const ama = [...engine.core.connections.values()].at(-1)!;
    await ama.lifecycleReady;
    await handle.handleMessage(
      JSON.stringify(['__subscribe__', null, { channel: { name: 'room' } }]),
    );

    expect(ama.channelMemberships.size).toBe(1);
    expect(readConnectionRow(storage.sql, ama.id)).toBeNull();
  });

  it('keeps the resume token a connection had before it hibernated', async () => {
    const storage = { sql: createTestSql(), kv: createTestKV() };
    const engine = buildEngine(storage);
    await engine.initialize();

    const kofi = hibernatedSocket('kofi');
    writeConnectionRow(storage.sql, {
      connection_id: kofi.id,
      user_id: kofi.id,
      meta: {},
      ephemeral_tags: [],
      ephemeral_memberships: [],
      active_stream_ids: [],
      metadata: { resumeToken: 'token-before-sleep' },
    });
    await engine.restoreHibernatedConnections([kofi.ws]);

    const restored = engine.core.connections.get('kofi');
    expect(restored?.resumeToken).toBe('token-before-sleep');
    expect(buildConnectionRow(restored!).metadata).toEqual({ resumeToken: 'token-before-sleep' });
  });

  it('replays a send made after a wake to a client showing the token from before the sleep', async () => {
    const storage = { sql: createTestSql(), kv: createTestKV() };
    const engine = buildEngine(storage, undefined, true);
    await engine.initialize();

    const kofi = hibernatedSocket('kofi');
    writeConnectionRow(storage.sql, {
      connection_id: kofi.id,
      user_id: kofi.id,
      meta: {},
      ephemeral_tags: [],
      ephemeral_memberships: [],
      active_stream_ids: [],
      metadata: { resumeToken: 'token-before-sleep' },
    });
    await engine
      .handleHibernationWake(kofi.ws)
      .handleMessage(JSON.stringify(['note-to-self', { text: 'medaase' }, null]));

    const frames: string[] = [];
    const again = engine.accept(Symbol('kofi-again'), {
      send: ({ text }: { kind: 'text'; text: string }) => void frames.push(text),
      close: () => {},
      bufferedAmount: () => 0,
      userId: 'kofi',
    });
    await Promise.resolve();
    await again.handleMessage(
      JSON.stringify(['__replay__', { lastKnownSeq: 0, resume: ['token-before-sleep'] }, null]),
    );

    const notes = frames.map((frame) => JSON.parse(frame)).filter((frame) => frame[0] === 'note');
    expect(notes.map((frame) => frame[1])).toEqual([{ text: 'medaase' }]);
  });

  it('returns false for a send to a restored socket that has closed', async () => {
    const storage = { sql: createTestSql(), kv: createTestKV() };
    const engine = buildEngine(storage);
    await engine.initialize();

    const kofi = hibernatedSocket('kofi');
    writeConnectionRow(storage.sql, {
      connection_id: kofi.id,
      user_id: kofi.id,
      meta: {},
      ephemeral_tags: [],
      ephemeral_memberships: [],
      active_stream_ids: [],
    });
    await engine.restoreHibernatedConnections([kofi.ws]);

    // workerd throws on send() once the socket has closed.
    Object.assign(kofi.ws, {
      readyState: 3,
      send: () => {
        throw new Error("Can't call WebSocket send() after close().");
      },
    });

    expect(
      engine.core.connections.get('kofi')?.descriptor.send({ kind: 'text', text: 'frame' }),
    ).toBe(false);
  });

  it('hands a bytes frame to a restored socket as the bytes themselves', async () => {
    const storage = { sql: createTestSql(), kv: createTestKV() };
    const engine = buildEngine(storage);
    await engine.initialize();

    const kofi = hibernatedSocket('kofi');
    const sent: unknown[] = [];
    Object.assign(kofi.ws, { send: (data: unknown) => void sent.push(data) });
    await engine.restoreHibernatedConnections([kofi.ws]);
    const bytes = new Uint8Array([1, 2, 3]);

    engine.core.connections.get('kofi')?.descriptor.send({ kind: 'bytes', bytes });

    expect(sent).toEqual([bytes]);
    expect(sent[0]).toBe(bytes);
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
