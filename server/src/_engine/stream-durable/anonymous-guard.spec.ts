import { DurableStreamRequiresUser } from '@livething/core';
import { createTestSql } from '~/_test/sql.ts';
import { describe, expect, it, vi } from 'vitest';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';
import { runDurableStream } from './runtime.ts';
import * as Storage from './storage.ts';
import type { DurableStreamRuntimeDef } from './runtime.ts';

function createConnection(userId: string): RuntimeConnection {
  return {
    id: 'c1',
    userId,
    socketKey: Symbol('c1'),
    descriptor: {
      send: vi.fn(),
      close() {},
      bufferedAmount() {
        return 0;
      },
    },
    meta: {},
    tags: { ephemeral: new Map(), persistent: new Map() },
    channelMemberships: new Map(),
    latency: null,
    quality: 'good',
  };
}

function createRuntime(sqlInstance: ReturnType<typeof createTestSql>) {
  return {
    sql: sqlInstance,
    activeStreams: new Map(),
    connections: new Map(),
    generateId: () => 'dstream_1',
    buildConnectionContext: () => ({ id: 'ctx', nudges: () => [] }),
    sendProtocolMessage: vi.fn(),
    sendThroughPipeline: vi.fn(() => true),
    broadcastToConnections: vi.fn(),
    persistAttachment: vi.fn(),
    logger: { warn: vi.fn() },
    errorHooks: [],
    handleRuntimeError: vi.fn(async () => {}),
  };
}

function baseDef(overrides: Partial<DurableStreamRuntimeDef> = {}): DurableStreamRuntimeDef {
  return {
    event: 'e',
    allowConcurrent: false,
    maxAgeMs: 60_000,
    retentionAfterEndMs: 30_000,
    generator: async function* () {} as never,
    ...overrides,
  };
}

describe('runDurableStream — anonymous connection guard', () => {
  it('rejects an anonymous connection (empty userId) with DurableStreamRequiresUser, writing no row', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const runtime = createRuntime(sql);
    const connection = createConnection('');

    let thrown: unknown;
    try {
      await runDurableStream(runtime as never, connection, {
        scope: {},
        def: baseDef(),
        payload: {},
        livething: undefined,
      });
    } catch (err) {
      thrown = err;
    }

    expect(DurableStreamRequiresUser.matches(thrown)).toBe(true);
    expect(Storage.readStream(sql, '', 'dstream_1')).toBeNull();
    expect(runtime.sendProtocolMessage).not.toHaveBeenCalled();
  });

  it('rejects for a recorded-broadcast stream too — the guard runs before the broadcast-key branch', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const runtime = createRuntime(sql);
    const connection = createConnection('');

    await expect(
      runDurableStream(runtime as never, connection, {
        scope: { channelName: 'room:general' } as never,
        def: baseDef({ broadcast: true }),
        payload: {},
        livething: undefined,
      }),
    ).rejects.toMatchObject({ code: 'durable-stream-requires-user' });
  });

  it('allows an identified user through the guard (stream row gets written under their id)', async () => {
    const sql = createTestSql();
    Storage.ensureDurableStreamSchema(sql);
    const runtime = createRuntime(sql);
    const connection = createConnection('u1');

    await runDurableStream(runtime as never, connection, {
      scope: {},
      def: baseDef({
        generator: async function* () {
          yield { i: 1 };
        },
      }),
      payload: {},
      livething: undefined,
    });

    expect(Storage.readStream(sql, 'u1', 'dstream_1')).not.toBeNull();
  });
});
