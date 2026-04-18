import { sendThroughPipeline } from '~/outgoing/runtime.ts';
import { describe, expect, it, vi } from 'vitest';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';
import type { OutgoingRuntime } from '~/outgoing/runtime.ts';

function createConnection(id = 'c1'): RuntimeConnection {
  return {
    id,
    wsKey: Symbol(id),
    descriptor: {
      send: vi.fn(),
      sendBinary() {},
      close() {},
      bufferedAmount() {
        return 0;
      },
    },
    meta: {},
    tags: new Set<string>(),
    channels: new Set<string>(),
    channelMemberships: new Map(),
    latency: null,
    quality: 'good',
  };
}

function createRuntime(overrides: Partial<OutgoingRuntime> = {}): OutgoingRuntime {
  return {
    compiled: {
      outgoing: new Map([['foo', { event: 'foo' }]]),
      streams: new Map(),
      namespaces: new Map(),
      channels: new Map(),
      channelFamilies: new Map(),
      modules: [],
    } as unknown as OutgoingRuntime['compiled'],
    moduleRuntimes: [],
    outgoingHooks: [],
    beforeSendHooks: [],
    afterSendHooks: [],
    waitUntil() {},
    logger: {
      warn() {},
      error() {},
    },
    generateId: () => 'id_1',
    ...overrides,
  };
}

describe('outgoing/runtime sendThroughPipeline', () => {
  it('throws when payload is an array', () => {
    const runtime = createRuntime();
    const connection = createConnection();

    expect(() => sendThroughPipeline(runtime, connection, undefined, 'foo', [] as unknown)).toThrow(
      /plain object/,
    );
  });

  it('throws when payload is a primitive number', () => {
    const runtime = createRuntime();
    const connection = createConnection();

    expect(() => sendThroughPipeline(runtime, connection, undefined, 'foo', 42 as unknown)).toThrow(
      /plain object/,
    );
  });

  it('throws when payload is a primitive string', () => {
    const runtime = createRuntime();
    const connection = createConnection();

    expect(() =>
      sendThroughPipeline(runtime, connection, undefined, 'foo', 'string' as unknown),
    ).toThrow(/plain object/);
  });

  it('rejects user-set reserved keys', () => {
    const runtime = createRuntime();
    const connection = createConnection();

    expect(() => sendThroughPipeline(runtime, connection, undefined, 'foo', { _seq: 99 })).toThrow(
      /reserved for the engine/,
    );
  });

  it('rejects new reserved keys added by hooks', () => {
    const runtime = createRuntime({
      moduleRuntimes: [
        {
          onOutgoing: (message: { event: string; payload: unknown }) => ({
            event: message.event,
            payload: { ...(message.payload as Record<string, unknown>), _x: 'leak' },
          }),
        } as unknown as OutgoingRuntime['moduleRuntimes'][number],
      ],
    });
    const connection = createConnection();

    expect(() => sendThroughPipeline(runtime, connection, undefined, 'foo', { a: 1 })).toThrow(
      /reserved for the engine/,
    );
  });

  it('passes a normal payload through cleanly', () => {
    const runtime = createRuntime();
    const connection = createConnection();

    const result = sendThroughPipeline(runtime, connection, undefined, 'foo', { a: 1 });

    expect(result).toBe(true);
    expect(connection.descriptor.send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(
      (connection.descriptor.send as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string,
    );
    expect(sent).toEqual({ event: 'foo', payload: { a: 1 } });
  });

  it('throws when the outgoing event was not declared in the active scope', () => {
    const runtime = createRuntime();
    const connection = createConnection();

    expect(() => sendThroughPipeline(runtime, connection, undefined, 'bar', {})).toThrow(
      /Outgoing event "bar" was not declared in the active scope/,
    );
  });
});
