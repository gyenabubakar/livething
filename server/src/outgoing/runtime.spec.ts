import { addChannelMembership } from '~/channel/runtime.ts';
import {
  broadcastToChannel,
  broadcastToConnections,
  sendThroughPipeline,
} from '~/outgoing/runtime.ts';
import { describe, expect, it, vi } from 'vitest';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';
import type { OutgoingRuntime } from '~/outgoing/runtime.ts';

function createConnection(id = 'c1'): RuntimeConnection {
  return {
    id,
    identity: id,
    wsKey: Symbol(id),
    descriptor: {
      send: vi.fn(),
      sendBinary() {},
      close() {},
      bufferedAmount() {
        return 0;
      },
      identity: id,
    },
    meta: {},
    tags: { ephemeral: new Map<string, Set<string>>(), persistent: new Map<string, Set<string>>() },
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
      resumableStreams: new Map(),
      recordedStreams: new Map(),
      namespaces: new Map(),
      channels: new Map(),
      channelFamilies: new Map(),
      modules: [],
    } as unknown as OutgoingRuntime['compiled'],
    pluginRuntimes: [],
    outgoingHooks: [],
    wskitStampHooks: [],
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

  it('lets a plugin add its own keys to the payload', () => {
    const runtime = createRuntime({
      pluginRuntimes: [
        {
          onOutgoing: (message: { event: string; payload: unknown }) => ({
            ...(message.payload as Record<string, unknown>),
            sentAt: 1,
          }),
        } as unknown as OutgoingRuntime['pluginRuntimes'][number],
      ],
    });
    const connection = createConnection();

    expect(() =>
      sendThroughPipeline(runtime, connection, undefined, 'foo', { a: 1 }),
    ).not.toThrow();
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
    expect(sent).toEqual({ event: 'foo', payload: { a: 1 }, __wskit: {} });
  });

  it('throws when the outgoing event was not declared in the active scope', () => {
    const runtime = createRuntime();
    const connection = createConnection();

    expect(() => sendThroughPipeline(runtime, connection, undefined, 'bar', {})).toThrow(
      /Outgoing event "bar" was not declared in the active scope/,
    );
  });

  it('rejects single-underscore names that are not engine protocol events', () => {
    // Pre-fix any `_*` name short-circuited as "protocol traffic" and went
    // out without declaration, sequence, dedup, or replay. Now only the
    // engine's known outgoing protocol names are accepted; any other
    // single-underscore name fails the declaration check.
    const runtime = createRuntime();
    const connection = createConnection();

    expect(() =>
      sendThroughPipeline(runtime, connection, undefined, '_evilName', { x: 1 }),
    ).toThrow(/Outgoing event "_evilName" was not declared in the active scope/);
    expect(() =>
      sendThroughPipeline(runtime, connection, undefined, '_anything', { x: 1 }),
    ).toThrow(/Outgoing event "_anything" was not declared/);
  });

  it('accepts an event declared in a namespace scope when namespace routing is provided', () => {
    const runtime = createRuntime({
      compiled: {
        outgoing: new Map(),
        streams: new Map(),
        resumableStreams: new Map(),
        recordedStreams: new Map(),
        namespaces: new Map([
          [
            'admin',
            {
              outgoing: new Map([['ns-event', { event: 'ns-event' }]]),
              streams: new Map(),
              resumableStreams: new Map(),
              recordedStreams: new Map(),
            },
          ],
        ]),
        channels: new Map(),
        channelFamilies: new Map(),
        modules: [],
      } as unknown as OutgoingRuntime['compiled'],
    });
    const connection = createConnection();

    expect(() =>
      sendThroughPipeline(runtime, connection, { namespace: 'admin' }, 'ns-event', { a: 1 }),
    ).not.toThrow();
  });

  it('accepts an event declared in a channel family scope when channelScope routing is provided', () => {
    const runtime = createRuntime({
      compiled: {
        outgoing: new Map(),
        streams: new Map(),
        resumableStreams: new Map(),
        recordedStreams: new Map(),
        namespaces: new Map(),
        channels: new Map(),
        channelFamilies: new Map([
          [
            'rooms',
            {
              outgoing: new Map([['room-event', { event: 'room-event' }]]),
              streams: new Map(),
              resumableStreams: new Map(),
              recordedStreams: new Map(),
            },
          ],
        ]),
        modules: [],
      } as unknown as OutgoingRuntime['compiled'],
    });
    const connection = createConnection();

    expect(() =>
      sendThroughPipeline(
        runtime,
        connection,
        { channel: 'room-1', channelScope: 'rooms' },
        'room-event',
        {
          a: 1,
        },
      ),
    ).not.toThrow();
  });

  it('throws when an undeclared event is sent inside a namespace scope', () => {
    const runtime = createRuntime({
      compiled: {
        outgoing: new Map(),
        streams: new Map(),
        resumableStreams: new Map(),
        recordedStreams: new Map(),
        namespaces: new Map([
          [
            'admin',
            {
              outgoing: new Map([['ns-event', { event: 'ns-event' }]]),
              streams: new Map(),
              resumableStreams: new Map(),
              recordedStreams: new Map(),
            },
          ],
        ]),
        channels: new Map(),
        channelFamilies: new Map(),
        modules: [],
      } as unknown as OutgoingRuntime['compiled'],
    });
    const connection = createConnection();

    // 'other-event' is not in the admin namespace's outgoing declarations.
    expect(() =>
      sendThroughPipeline(runtime, connection, { namespace: 'admin' }, 'other-event', {}),
    ).toThrow(/Outgoing event "other-event" was not declared in the active scope/);
  });

  it('accepts an event declared in a named channel scope when channel routing is provided', () => {
    const runtime = createRuntime({
      compiled: {
        outgoing: new Map(),
        streams: new Map(),
        resumableStreams: new Map(),
        recordedStreams: new Map(),
        namespaces: new Map(),
        channels: new Map([
          [
            'general',
            {
              outgoing: new Map([['chat-msg', { event: 'chat-msg' }]]),
              streams: new Map(),
              resumableStreams: new Map(),
              recordedStreams: new Map(),
            },
          ],
        ]),
        channelFamilies: new Map(),
        modules: [],
      } as unknown as OutgoingRuntime['compiled'],
    });
    const connection = createConnection();

    expect(() =>
      sendThroughPipeline(runtime, connection, { channel: 'general' }, 'chat-msg', { a: 1 }),
    ).not.toThrow();
  });
});

describe('broadcastToConnections — fanout resilience', () => {
  function peer(id: string, send: (frame: string) => void): RuntimeConnection {
    return {
      id,
      identity: id,
      wsKey: Symbol(id),
      descriptor: {
        send,
        sendBinary() {},
        close() {},
        bufferedAmount() {
          return 0;
        },
        identity: id,
      },
      meta: {},
      tags: {
        ephemeral: new Map<string, Set<string>>(),
        persistent: new Map<string, Set<string>>(),
      },
      channelMemberships: new Map(),
      latency: null,
      quality: 'good',
    };
  }

  it('keeps delivering to remaining peers when one peer descriptor.send throws', () => {
    const errorLogs: Array<{ message: string; data?: unknown }> = [];
    const runtime = createRuntime({
      logger: {
        warn() {},
        error(message: string, data?: unknown) {
          errorLogs.push({ message, data });
        },
      },
    });
    const delivered: string[] = [];
    const a = peer('A', (frame) => delivered.push(`A:${frame}`));
    const b = peer('B', () => {
      throw new Error('InvalidStateError: socket is CLOSING');
    });
    const c = peer('C', (frame) => delivered.push(`C:${frame}`));

    expect(() => broadcastToConnections(runtime, [a, b, c], 'foo', { text: 'hi' })).not.toThrow();

    expect(delivered).toHaveLength(2);
    expect(delivered[0]).toContain('A:');
    expect(delivered[1]).toContain('C:');
    expect(errorLogs).toHaveLength(1);
    expect((errorLogs[0]!.data as { connectionId: string }).connectionId).toBe('B');
  });

  it('reports an unserializable broadcast payload once and does not throw (BigInt)', () => {
    // The payload is serialized once for the whole broadcast. A BigInt makes
    // JSON.stringify throw, so preparation fails, a single error is logged,
    // and nobody receives the frame — without crashing the dispatcher.
    const errorLogs: Array<{ message: string; data?: unknown }> = [];
    const runtime = createRuntime({
      logger: {
        warn() {},
        error(message: string, data?: unknown) {
          errorLogs.push({ message, data });
        },
      },
    });
    const a = peer('A', () => {});
    const b = peer('B', () => {});

    expect(() =>
      broadcastToConnections(runtime, [a, b], 'foo', { count: 1n } as unknown as object),
    ).not.toThrow();

    expect(errorLogs).toHaveLength(1);
  });

  it('produces a wire frame that parses to event, payload, and __wskit', () => {
    const sent: string[] = [];
    const runtime = createRuntime({ wskitStampHooks: [() => ({ seq: 7 })] });
    const a = peer('A', (frame) => sent.push(frame));
    const b = peer('B', (frame) => sent.push(frame));

    broadcastToConnections(runtime, [a, b], 'foo', { text: 'hi', n: 42 });

    expect(sent).toHaveLength(2);
    for (const frame of sent) {
      expect(JSON.parse(frame)).toEqual({
        event: 'foo',
        payload: { text: 'hi', n: 42 },
        __wskit: { seq: 7 },
      });
    }
  });

  it('reuses one frame string across recipients when no stamper varies __wskit', () => {
    const sent: string[] = [];
    const runtime = createRuntime();
    const a = peer('A', (frame) => sent.push(frame));
    const b = peer('B', (frame) => sent.push(frame));

    broadcastToConnections(runtime, [a, b], 'foo', { text: 'hi' });

    expect(sent).toHaveLength(2);
    expect(sent[0]).toBe(sent[1]);
    expect(JSON.parse(sent[0]!)).toEqual({ event: 'foo', payload: { text: 'hi' }, __wskit: {} });
  });
});

describe('broadcastToChannel — fanout resilience', () => {
  function peer(
    channelMembers: Map<string, Set<RuntimeConnection>>,
    id: string,
    send: (frame: string) => void,
  ): RuntimeConnection {
    const conn: RuntimeConnection = {
      id,
      identity: id,
      wsKey: Symbol(id),
      descriptor: {
        send,
        sendBinary() {},
        close() {},
        bufferedAmount() {
          return 0;
        },
        identity: id,
      },
      meta: {},
      tags: {
        ephemeral: new Map<string, Set<string>>(),
        persistent: new Map<string, Set<string>>(),
      },
      channelMemberships: new Map(),
      latency: null,
      quality: 'good',
    };
    addChannelMembership(channelMembers, conn, 'general', null);
    return conn;
  }

  it('keeps delivering to remaining channel members when one peer throws', () => {
    const errorLogs: Array<{ message: string; data?: unknown }> = [];
    const channelMembers = new Map<string, Set<RuntimeConnection>>();
    const a = peer(channelMembers, 'A', () => {});
    const b = peer(channelMembers, 'B', () => {
      throw new Error('InvalidStateError: socket is CLOSING');
    });
    const c = peer(channelMembers, 'C', () => {});
    const connections = new Map<string, RuntimeConnection>([
      [a.id, a],
      [b.id, b],
      [c.id, c],
    ]);

    const runtime = {
      ...createRuntime({
        compiled: {
          outgoing: new Map([['msg', { event: 'msg' }]]),
          streams: new Map(),
          resumableStreams: new Map(),
          recordedStreams: new Map(),
          namespaces: new Map(),
          channels: new Map([['general', { outgoing: new Map([['msg', { event: 'msg' }]]) }]]),
          channelFamilies: new Map(),
          modules: [],
        } as unknown as OutgoingRuntime['compiled'],
        logger: {
          warn() {},
          error(message: string, data?: unknown) {
            errorLogs.push({ message, data });
          },
        },
      }),
      connections,
      channelMembers,
    } as OutgoingRuntime & {
      connections: Map<string, RuntimeConnection>;
      channelMembers: Map<string, Set<RuntimeConnection>>;
    };

    expect(() =>
      broadcastToChannel(runtime as never, 'general', 'msg', { text: 'hi' }, undefined, null),
    ).not.toThrow();

    expect(errorLogs).toHaveLength(1);
    expect((errorLogs[0]!.data as { connectionId: string }).connectionId).toBe('B');
    expect((errorLogs[0]!.data as { channel: string }).channel).toBe('general');
  });
});
