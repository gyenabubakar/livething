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
      plugins: [],
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

    expect(() =>
      sendThroughPipeline(runtime, connection, {
        routing: undefined,
        event: 'foo',
        payload: [] as unknown,
      }),
    ).toThrow(/plain object/);
  });

  it("keeps a stream chunk's own seq even when a global seq stamper is active", () => {
    // The global sequence stamper would set seq=999, but a durable stream
    // chunk carries its own per-stream seq in routing. The chunk's seq must
    // win, or interleaved global traffic would make chunk seqs look gappy and
    // break the client's missed-chunk detection.
    const runtime = createRuntime({ wskitStampHooks: [() => ({ seq: 999 })] });
    const connection = createConnection();
    const send = connection.descriptor.send as ReturnType<typeof vi.fn>;

    sendThroughPipeline(runtime, connection, {
      routing: { streamId: 's1', seq: 3 },
      event: 'foo',
      payload: { n: 1 },
    });

    const sent = JSON.parse(send.mock.calls[0]![0] as string);
    expect(sent.__wskit.seq).toBe(3);
    expect(sent.__wskit.streamId).toBe('s1');

    // A regular message (no seq in routing) still gets the stamped global seq.
    send.mockClear();
    sendThroughPipeline(runtime, connection, {
      routing: undefined,
      event: 'foo',
      payload: { n: 2 },
    });
    expect(JSON.parse(send.mock.calls[0]![0] as string).__wskit.seq).toBe(999);
  });

  it('throws when payload is a primitive number', () => {
    const runtime = createRuntime();
    const connection = createConnection();

    expect(() =>
      sendThroughPipeline(runtime, connection, {
        routing: undefined,
        event: 'foo',
        payload: 42 as unknown,
      }),
    ).toThrow(/plain object/);
  });

  it('throws when payload is a primitive string', () => {
    const runtime = createRuntime();
    const connection = createConnection();

    expect(() =>
      sendThroughPipeline(runtime, connection, {
        routing: undefined,
        event: 'foo',
        payload: 'string' as unknown,
      }),
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
      sendThroughPipeline(runtime, connection, {
        routing: undefined,
        event: 'foo',
        payload: { a: 1 },
      }),
    ).not.toThrow();
  });

  it('passes a normal payload through cleanly', () => {
    const runtime = createRuntime();
    const connection = createConnection();

    const result = sendThroughPipeline(runtime, connection, {
      routing: undefined,
      event: 'foo',
      payload: { a: 1 },
    });

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

    expect(() =>
      sendThroughPipeline(runtime, connection, { routing: undefined, event: 'bar', payload: {} }),
    ).toThrow(/Outgoing event "bar" was not declared in the active scope/);
  });

  it('rejects single-underscore names that are not engine protocol events', () => {
    // Pre-fix any `_*` name short-circuited as "protocol traffic" and went
    // out without declaration, sequence, dedup, or replay. Now only the
    // engine's known outgoing protocol names are accepted; any other
    // single-underscore name fails the declaration check.
    const runtime = createRuntime();
    const connection = createConnection();

    expect(() =>
      sendThroughPipeline(runtime, connection, {
        routing: undefined,
        event: '_evilName',
        payload: { x: 1 },
      }),
    ).toThrow(/Outgoing event "_evilName" was not declared in the active scope/);
    expect(() =>
      sendThroughPipeline(runtime, connection, {
        routing: undefined,
        event: '_anything',
        payload: { x: 1 },
      }),
    ).toThrow(/Outgoing event "_anything" was not declared/);
  });

  it('accepts a real protocol event but rejects an unknown __x__ name', () => {
    // Only the engine's actual protocol names are waved through. A made-up
    // __x__ name must not pass as protocol traffic and skip the scope check.
    const runtime = createRuntime();
    const connection = createConnection();

    expect(() =>
      sendThroughPipeline(runtime, connection, {
        routing: undefined,
        event: '__memberJoin__',
        payload: { connectionId: 'c1' },
      }),
    ).not.toThrow();

    expect(() =>
      sendThroughPipeline(runtime, connection, {
        routing: undefined,
        event: '__madeUp__',
        payload: { x: 1 },
      }),
    ).toThrow(/Outgoing event "__madeUp__" was not declared in the active scope/);
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
        plugins: [],
      } as unknown as OutgoingRuntime['compiled'],
    });
    const connection = createConnection();

    expect(() =>
      sendThroughPipeline(runtime, connection, {
        routing: { namespace: 'admin' },
        event: 'ns-event',
        payload: { a: 1 },
      }),
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
        plugins: [],
      } as unknown as OutgoingRuntime['compiled'],
    });
    const connection = createConnection();

    expect(() =>
      sendThroughPipeline(runtime, connection, {
        routing: { channel: 'room-1', channelScope: 'rooms' },
        event: 'room-event',
        payload: { a: 1 },
      }),
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
        plugins: [],
      } as unknown as OutgoingRuntime['compiled'],
    });
    const connection = createConnection();

    // 'other-event' is not in the admin namespace's outgoing declarations.
    expect(() =>
      sendThroughPipeline(runtime, connection, {
        routing: { namespace: 'admin' },
        event: 'other-event',
        payload: {},
      }),
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
        plugins: [],
      } as unknown as OutgoingRuntime['compiled'],
    });
    const connection = createConnection();

    expect(() =>
      sendThroughPipeline(runtime, connection, {
        routing: { channel: 'general' },
        event: 'chat-msg',
        payload: { a: 1 },
      }),
    ).not.toThrow();
  });

  it('throws a clear error when the payload serializes to undefined (toJSON returns undefined)', () => {
    // assertPayloadRecord only checks the in-memory shape, so an object whose
    // toJSON returns undefined passes that gate. Without the serialize-time
    // guard the unicast wire frame silently drops its payload key — the
    // client receives `{"event":"foo","__wskit":{...}}` and has no signal
    // that the payload was lost. The guard turns it into a loud server-side
    // error pointing at the offending event name.
    const runtime = createRuntime();
    const connection = createConnection();
    const bad = { toJSON: () => undefined } as unknown as Record<string, unknown>;

    expect(() =>
      sendThroughPipeline(runtime, connection, {
        routing: undefined,
        event: 'foo',
        payload: bad,
      }),
    ).toThrow(/did not serialize to JSON/);
    expect(connection.descriptor.send).not.toHaveBeenCalled();
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

    expect(() =>
      broadcastToConnections(runtime, [a, b, c], { event: 'foo', payload: { text: 'hi' } }),
    ).not.toThrow();

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
      broadcastToConnections(runtime, [a, b], {
        event: 'foo',
        payload: { count: 1n } as unknown as object,
      }),
    ).not.toThrow();

    expect(errorLogs).toHaveLength(1);
  });

  it('drops the broadcast and logs once when the payload serializes to undefined (toJSON returns undefined)', () => {
    // Pre-fix the splice path produced `"payload":undefined` on the wire —
    // invalid JSON that broke every recipient's parser. The serialize-time
    // guard fails preparation, the existing catch logs one error, and no
    // peer receives the frame.
    const errorLogs: Array<{ message: string; data?: unknown }> = [];
    const runtime = createRuntime({
      logger: {
        warn() {},
        error(message: string, data?: unknown) {
          errorLogs.push({ message, data });
        },
      },
    });
    const sent: string[] = [];
    const a = peer('A', (frame) => sent.push(frame));
    const b = peer('B', (frame) => sent.push(frame));
    const bad = { toJSON: () => undefined } as unknown as Record<string, unknown>;

    expect(() =>
      broadcastToConnections(runtime, [a, b], { event: 'foo', payload: bad }),
    ).not.toThrow();

    expect(sent).toEqual([]);
    expect(errorLogs).toHaveLength(1);
    expect((errorLogs[0]!.data as { error: string }).error).toMatch(/did not serialize to JSON/);
  });

  it('produces a wire frame that parses to event, payload, and __wskit', () => {
    const sent: string[] = [];
    const runtime = createRuntime({ wskitStampHooks: [() => ({ seq: 7 })] });
    const a = peer('A', (frame) => sent.push(frame));
    const b = peer('B', (frame) => sent.push(frame));

    broadcastToConnections(runtime, [a, b], { event: 'foo', payload: { text: 'hi', n: 42 } });

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

    broadcastToConnections(runtime, [a, b], { event: 'foo', payload: { text: 'hi' } });

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
    addChannelMembership(channelMembers, conn, { channelName: 'general', channelScope: null });
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
          plugins: [],
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
      broadcastToChannel(runtime as never, {
        channelName: 'general',
        event: 'msg',
        payload: { text: 'hi' },
        excludeConnectionId: undefined,
        channelScope: null,
      }),
    ).not.toThrow();

    expect(errorLogs).toHaveLength(1);
    expect((errorLogs[0]!.data as { connectionId: string }).connectionId).toBe('B');
    expect((errorLogs[0]!.data as { channel: string }).channel).toBe('general');
  });
});
