import { LiveThingConfigError } from '@livething/core';
import { addChannelMembership } from '~/channel/runtime.ts';
import { APP_HOOK_OWNER } from '~/intercept/intercept.ts';
import {
  broadcastToChannel,
  broadcastToConnections,
  broadcastToUser,
  openSharedSend,
  sendThroughPipeline,
  sendToConnections,
} from '~/outgoing/runtime.ts';
import { frameOwner } from '~/plugin-scope.ts';
import { describe, expect, it, vi } from 'vitest';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';
import type { OutgoingFrame } from '~/intercept/intercept.ts';
import type { OutgoingRuntime } from '~/outgoing/runtime.ts';

function createConnection(id = 'c1'): RuntimeConnection {
  return {
    id,
    userId: id,
    socketKey: Symbol(id),
    descriptor: {
      send: vi.fn(),
      close() {},
      bufferedAmount() {
        return 0;
      },
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
      recordedStreams: new Map(),
      channels: new Map(),
      channelFamilies: new Map(),
    } as unknown as OutgoingRuntime['compiled'],
    outgoingHooks: [],
    livethingStampHooks: [],
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

  it("keeps a stream chunk's own sequence even when a global sequence stamper is active", () => {
    // The global sequence stamper would set deliverySeq=999, but a durable stream
    // chunk carries its own per-stream sequence in routing. The chunk's sequence must
    // win, or interleaved global traffic would make chunk seqs look gappy and
    // break the client's missed-chunk detection.
    const runtime = createRuntime({ livethingStampHooks: [() => ({ deliverySeq: 999 })] });
    const connection = createConnection();
    const send = connection.descriptor.send as ReturnType<typeof vi.fn>;

    sendThroughPipeline(runtime, connection, {
      routing: { streamId: 's1', streamSeq: 3 },
      event: 'foo',
      payload: { n: 1 },
    });

    const sent = JSON.parse(send.mock.calls[0]![0].text as string);
    expect(sent[2].stream).toMatchObject({ seq: 3, id: 's1' });
    expect(sent[2].delivery).toBeUndefined();

    // A regular message (no seq in routing) still gets the stamped global seq.
    send.mockClear();
    sendThroughPipeline(runtime, connection, {
      routing: undefined,
      event: 'foo',
      payload: { n: 2 },
    });
    expect(JSON.parse(send.mock.calls[0]![0].text as string)[2].delivery.seq).toBe(999);
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
      (connection.descriptor.send as ReturnType<typeof vi.fn>).mock.calls[0]![0].text as string,
    );
    expect(sent).toEqual(['foo', { a: 1 }, null]);
  });

  it('sends a void request-response acknowledgement with no payload key at all', () => {
    const runtime = createRuntime();
    const connection = createConnection();
    const send = connection.descriptor.send as ReturnType<typeof vi.fn>;

    expect(() =>
      sendThroughPipeline(runtime, connection, {
        routing: { correlationId: 'req123', source: 'client' },
        event: 'ping',
        payload: undefined,
      }),
    ).not.toThrow();

    const sent = JSON.parse(send.mock.calls[0]![0].text as string);
    expect(sent).toEqual(['ping', null, { exchange: { id: 'req123', source: 'client' } }]);
  });

  it('still runs the outgoing hooks for a void acknowledgement', () => {
    const seen: string[] = [];
    const runtime = createRuntime({
      outgoingHooks: [
        {
          owner: APP_HOOK_OWNER,
          handler: (frame) => {
            seen.push(frame.event);
          },
        },
      ],
    });
    const connection = createConnection();

    sendThroughPipeline(runtime, connection, {
      routing: { correlationId: 'req123', source: 'client' },
      event: 'ping',
      payload: undefined,
    });

    expect(seen).toEqual(['ping']);
  });

  it('still rejects an undefined payload when it is not a request-response', () => {
    const runtime = createRuntime();
    const connection = createConnection();

    expect(() =>
      sendThroughPipeline(runtime, connection, {
        routing: undefined,
        event: 'foo',
        payload: undefined as unknown,
      }),
    ).toThrow(/plain object/);
  });

  it('throws when the outgoing event was not declared in the active scope', () => {
    const runtime = createRuntime();
    const connection = createConnection();

    expect(() =>
      sendThroughPipeline(runtime, connection, { routing: undefined, event: 'bar', payload: {} }),
    ).toThrow(/Outgoing event "bar" was not declared in the active scope/);
  });

  it('rejects single-underscore names that are not engine protocol events', () => {
    // Only known protocol names bypass application-event declaration checks.
    // Any other single-underscore name is rejected.
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
        event: '__memberChanges__',
        payload: { changes: [] },
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

  it('accepts an event declared in a channel family scope when channelFamily routing is provided', () => {
    const runtime = createRuntime({
      compiled: {
        outgoing: new Map(),
        streams: new Map(),
        recordedStreams: new Map(),
        channels: new Map(),
        channelFamilies: new Map([
          [
            'rooms',
            {
              outgoing: new Map([['room-event', { event: 'room-event' }]]),
              streams: new Map(),
              recordedStreams: new Map(),
            },
          ],
        ]),
      } as unknown as OutgoingRuntime['compiled'],
    });
    const connection = createConnection();

    expect(() =>
      sendThroughPipeline(runtime, connection, {
        routing: { channel: 'room-1', channelFamily: 'rooms' },
        event: 'room-event',
        payload: { a: 1 },
      }),
    ).not.toThrow();
  });

  it('accepts an event declared in a named channel scope when channel routing is provided', () => {
    const runtime = createRuntime({
      compiled: {
        outgoing: new Map(),
        streams: new Map(),
        recordedStreams: new Map(),
        channels: new Map([
          [
            'general',
            {
              outgoing: new Map([['chat-msg', { event: 'chat-msg' }]]),
              streams: new Map(),
              recordedStreams: new Map(),
            },
          ],
        ]),
        channelFamilies: new Map(),
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

  it('refuses a payload whose JSON is not an object, judged on the JSON that is sent', () => {
    // A Date and a boxed number are objects in memory, but JSON turns them into a string and a
    // number. A Map becomes {} and loses its data. A toJSON that returns undefined sends nothing.
    const runtime = createRuntime();
    const connection = createConnection();
    const cases: [unknown, RegExp][] = [
      [new Date(0), /JSON turned into "1970/],
      [new Number(7), /JSON turned into 7/],
      [new Map([['ada', 1]]), /an iterable such as a Map or a Set/],
      [{ toJSON: () => undefined }, /did not serialize to JSON/],
    ];

    for (const [payload, message] of cases) {
      expect(() =>
        sendThroughPipeline(runtime, connection, {
          routing: undefined,
          event: 'foo',
          payload: payload as Record<string, unknown>,
        }),
      ).toThrow(message);
    }

    expect(connection.descriptor.send).not.toHaveBeenCalled();
  });

  it('sends what toJSON returns, calling it once with the root key, as JSON does', () => {
    const runtime = createRuntime();
    const connection = createConnection();
    const keys: unknown[] = [];
    // An ORM record: toJSON gives an object. A second call would give something else.
    const record = {
      id: 'm1',
      secret: 'hidden',
      toJSON(key: unknown) {
        keys.push(key);
        return keys.length === 1 ? { id: 'm1' } : 'changed';
      },
    };

    // An iterable is fine when its toJSON() decides what is sent.
    const roster = { *[Symbol.iterator]() {}, toJSON: () => ({ names: ['ada'] }) };

    sendThroughPipeline(runtime, connection, { routing: undefined, event: 'foo', payload: record });
    sendThroughPipeline(runtime, connection, { routing: undefined, event: 'foo', payload: roster });

    const frames = vi.mocked(connection.descriptor.send).mock.calls.map(([frame]) => frame);
    expect(frames.map((frame) => JSON.parse((frame as { text: string }).text)[1])).toEqual([
      { id: 'm1' },
      { names: ['ada'] },
    ]);
    expect(keys).toEqual(['']);
  });
});

describe('broadcastToConnections — fanout resilience', () => {
  function peer(id: string, send: (frame: string) => void): RuntimeConnection {
    return {
      id,
      userId: id,
      socketKey: Symbol(id),
      descriptor: {
        send: ({ text }: { kind: 'text'; text: string }) => send(text),
        close() {},
        bufferedAmount() {
          return 0;
        },
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

  it('propagates a configuration error from a peer instead of hiding it in fanout logs', () => {
    const runtime = createRuntime();
    const a = peer('A', () => {});
    const b = peer('B', () => {
      throw new LiveThingConfigError('bad adapter config');
    });

    expect(() =>
      broadcastToConnections(runtime, [a, b], { event: 'foo', payload: { text: 'hi' } }),
    ).toThrow(LiveThingConfigError);
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

  it('calls toJSON once for the whole broadcast, so every peer gets the same payload', () => {
    const runtime = createRuntime();
    const sent: string[] = [];
    const a = peer('A', (frame) => sent.push(frame));
    const b = peer('B', (frame) => sent.push(frame));
    let calls = 0;

    const record = {
      toJSON() {
        calls += 1;
        return { version: calls };
      },
    };

    broadcastToConnections(runtime, [a, b], { event: 'foo', payload: record });

    expect(calls).toBe(1);
    expect(sent.map((frame) => JSON.parse(frame)[1])).toEqual([{ version: 1 }, { version: 1 }]);
  });

  it('drops the broadcast and logs once when the payload serializes to nothing', () => {
    // The payload check rejects it, logs one error, and sends no frame to any peer.
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

  it('produces a wire frame that parses to event, payload, and __livething', () => {
    const sent: string[] = [];
    const runtime = createRuntime({ livethingStampHooks: [() => ({ deliverySeq: 7 })] });
    const a = peer('A', (frame) => sent.push(frame));
    const b = peer('B', (frame) => sent.push(frame));

    broadcastToConnections(runtime, [a, b], { event: 'foo', payload: { text: 'hi', n: 42 } });

    expect(sent).toHaveLength(2);
    for (const frame of sent) {
      expect(JSON.parse(frame)).toEqual(['foo', { text: 'hi', n: 42 }, { delivery: { seq: 7 } }]);
    }
  });

  it('reuses one frame string across recipients when no stamper varies __livething', () => {
    const sent: string[] = [];
    const runtime = createRuntime();
    const a = peer('A', (frame) => sent.push(frame));
    const b = peer('B', (frame) => sent.push(frame));

    broadcastToConnections(runtime, [a, b], { event: 'foo', payload: { text: 'hi' } });

    expect(sent).toHaveLength(2);
    expect(sent[0]).toBe(sent[1]);
    expect(JSON.parse(sent[0]!)).toEqual(['foo', { text: 'hi' }, null]);
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
      userId: id,
      socketKey: Symbol(id),
      descriptor: {
        send: ({ text }: { kind: 'text'; text: string }) => send(text),
        close() {},
        bufferedAmount() {
          return 0;
        },
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

    addChannelMembership(channelMembers, conn, { channelName: 'general', channelFamily: null });
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
          recordedStreams: new Map(),
          channels: new Map([['general', { outgoing: new Map([['msg', { event: 'msg' }]]) }]]),
          channelFamilies: new Map(),
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
        channelFamily: null,
      }),
    ).not.toThrow();

    expect(errorLogs).toHaveLength(1);
    expect((errorLogs[0]!.data as { connectionId: string }).connectionId).toBe('B');
    expect((errorLogs[0]!.data as { channel: string }).channel).toBe('general');
  });
});

describe('broadcastToChannel — stamp once, inbox reads the shared seq/messageId', () => {
  function inboxPeer(
    channelMembers: Map<string, Set<RuntimeConnection>>,
    id: string,
    send: (frame: string) => void,
  ): RuntimeConnection {
    const conn: RuntimeConnection = {
      id,
      userId: id,
      socketKey: Symbol(id),
      descriptor: {
        send: ({ text }: { kind: 'text'; text: string }) => send(text),
        close() {},
        bufferedAmount() {
          return 0;
        },
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

    addChannelMembership(channelMembers, conn, { channelName: 'general', channelFamily: null });
    return conn;
  }

  type FanOutOpts = {
    channelName: string;
    channelFamily: string | null;
    event: string;
    payload: Record<string, unknown>;
    deliverySeq: number;
    messageId: string;
  };

  function inboxRuntime(
    overrides: Partial<OutgoingRuntime> & {
      inboxFanOut?: (opts: FanOutOpts) => void;
    },
    channelMembers: Map<string, Set<RuntimeConnection>>,
  ) {
    return {
      ...createRuntime({
        compiled: {
          outgoing: new Map([['msg', { event: 'msg' }]]),
          streams: new Map(),
          recordedStreams: new Map(),
          channels: new Map([['general', { outgoing: new Map([['msg', { event: 'msg' }]]) }]]),
          channelFamilies: new Map(),
        } as unknown as OutgoingRuntime['compiled'],
        ...overrides,
      }),
      connections: new Map<string, RuntimeConnection>(),
      channelMembers,
    } as unknown as OutgoingRuntime;
  }

  function broadcastOnce(runtime: OutgoingRuntime) {
    broadcastToChannel(runtime as never, {
      channelName: 'general',
      event: 'msg',
      payload: { text: 'hi' },
      excludeConnectionId: undefined,
      channelFamily: null,
    });
  }

  it('stamps seq/messageId once and hands the same pair to the inbox fan-out', () => {
    const channelMembers = new Map<string, Set<RuntimeConnection>>();
    const sent: string[] = [];
    inboxPeer(channelMembers, 'A', (f) => sent.push(f));
    inboxPeer(channelMembers, 'B', (f) => sent.push(f));

    let stamperCalls = 0;
    const fanOutSeen: FanOutOpts[] = [];
    const runtime = inboxRuntime(
      {
        livethingStampHooks: [
          () => {
            stamperCalls += 1;
            return { deliverySeq: 42, messageId: 'msg_1' };
          },
        ],
        inboxFanOut: (opts) => void fanOutSeen.push(opts),
      },
      channelMembers,
    );

    broadcastOnce(runtime);

    // The stamper fires exactly once for the whole broadcast, not once per member.
    expect(stamperCalls).toBe(1);
    expect(fanOutSeen).toHaveLength(1);
    expect(fanOutSeen[0]).toMatchObject({ deliverySeq: 42, messageId: 'msg_1', event: 'msg' });

    expect(sent).toHaveLength(2);
    expect(sent[0]).toBe(sent[1]);
    const frame = JSON.parse(sent[0]!);
    expect(frame[2]).toMatchObject({
      delivery: { seq: 42, id: 'msg_1' },
      channel: { name: 'general' },
    });
  });

  it('produces byte-identical frames whether inboxFanOut runs or is absent', () => {
    function run(withFanOut: boolean): string[] {
      const channelMembers = new Map<string, Set<RuntimeConnection>>();
      const sent: string[] = [];
      inboxPeer(channelMembers, 'A', (f) => sent.push(f));
      inboxPeer(channelMembers, 'B', (f) => sent.push(f));
      const runtime = inboxRuntime(withFanOut ? { inboxFanOut: () => {} } : {}, channelMembers);

      broadcastOnce(runtime);

      return sent;
    }

    expect(run(true)).toEqual(run(false));
  });

  it('excludes the sender from the inbox row when its excluded connection is its only one in the channel', () => {
    const channelMembers = new Map<string, Set<RuntimeConnection>>();
    const sent: string[] = [];
    inboxPeer(channelMembers, 'A', (f) => sent.push(f)); // sender, connection id === userId 'A'
    inboxPeer(channelMembers, 'B', (f) => sent.push(f));

    const fanOutSeen: FanOutOpts[] = [];
    const runtime = inboxRuntime(
      {
        livethingStampHooks: [() => ({ deliverySeq: 1, messageId: 'm1' })],
        inboxFanOut: (opts) => void fanOutSeen.push(opts),
      },
      channelMembers,
    );

    broadcastToChannel(runtime as never, {
      channelName: 'general',
      event: 'msg',
      payload: { text: 'hi' },
      excludeConnectionId: 'A',
      channelFamily: null,
    });

    // Sender excluded from the live broadcast, and from the inbox row too.
    expect(sent).toHaveLength(1);
    expect((fanOutSeen[0] as FanOutOpts & { excludeUserId?: string }).excludeUserId).toBe('A');
  });

  it('still writes the sender an inbox row when a second connection of theirs remains in the channel', () => {
    const channelMembers = new Map<string, Set<RuntimeConnection>>();
    const sent: string[] = [];
    // Two connections share the same userId 'A' — a second tab.
    const secondTab: RuntimeConnection = {
      id: 'A-tab2',
      userId: 'A',
      socketKey: Symbol('A-tab2'),
      descriptor: {
        send: ({ text }: { kind: 'text'; text: string }) => sent.push(text),
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

    inboxPeer(channelMembers, 'A', (f) => sent.push(f));
    addChannelMembership(channelMembers, secondTab, {
      channelName: 'general',
      channelFamily: null,
    });
    inboxPeer(channelMembers, 'B', (f) => sent.push(f));

    const fanOutSeen: FanOutOpts[] = [];
    const runtime = inboxRuntime(
      {
        livethingStampHooks: [() => ({ deliverySeq: 1, messageId: 'm1' })],
        inboxFanOut: (opts) => void fanOutSeen.push(opts),
      },
      channelMembers,
    );

    broadcastToChannel(runtime as never, {
      channelName: 'general',
      event: 'msg',
      payload: { text: 'hi' },
      excludeConnectionId: 'A',
      channelFamily: null,
    });

    // Sender's first connection excluded from the live send, second tab still receives it.
    expect(sent).toHaveLength(2);
    expect(
      (fanOutSeen[0] as FanOutOpts & { excludeUserId?: string }).excludeUserId,
    ).toBeUndefined();
  });

  it('includeSelf never excludes the inbox row', () => {
    const channelMembers = new Map<string, Set<RuntimeConnection>>();
    const sent: string[] = [];
    inboxPeer(channelMembers, 'A', (f) => sent.push(f));

    const fanOutSeen: FanOutOpts[] = [];
    const runtime = inboxRuntime(
      {
        livethingStampHooks: [() => ({ deliverySeq: 1, messageId: 'm1' })],
        inboxFanOut: (opts) => void fanOutSeen.push(opts),
      },
      channelMembers,
    );

    broadcastToChannel(runtime as never, {
      channelName: 'general',
      event: 'msg',
      payload: { text: 'hi' },
      excludeConnectionId: 'A',
      channelFamily: null,
      includeSelf: true,
    });

    expect(sent).toHaveLength(1);
    expect(
      (fanOutSeen[0] as FanOutOpts & { excludeUserId?: string }).excludeUserId,
    ).toBeUndefined();
  });

  it('still broadcasts live when the inbox fan-out throws', () => {
    const channelMembers = new Map<string, Set<RuntimeConnection>>();
    const sent: string[] = [];
    inboxPeer(channelMembers, 'A', (f) => sent.push(f));
    const runtime = inboxRuntime(
      {
        livethingStampHooks: [() => ({ deliverySeq: 1, messageId: 'm1' })],
        inboxFanOut: () => {
          throw new Error('storage down');
        },
      },
      channelMembers,
    );

    expect(() => broadcastOnce(runtime)).not.toThrow();
    expect(sent).toHaveLength(1);
  });
});

describe('broadcast hooks — one call per broadcast', () => {
  function member(channelMembers: Map<string, Set<RuntimeConnection>>, id: string) {
    const conn = createConnection(id);
    addChannelMembership(channelMembers, conn, { channelName: 'general', channelFamily: null });
    return conn;
  }

  function channelRuntime(overrides: Partial<OutgoingRuntime>) {
    return {
      ...createRuntime({
        compiled: {
          outgoing: new Map(),
          streams: new Map(),
          recordedStreams: new Map(),
          channels: new Map([
            [
              'general',
              {
                outgoing: new Map([['foo', { event: 'foo' }]]),
                streams: new Map(),
                recordedStreams: new Map(),
              },
            ],
          ]),
          channelFamilies: new Map(),
        } as unknown as OutgoingRuntime['compiled'],
        ...overrides,
      }),
      connections: new Map<string, RuntimeConnection>(),
      channelMembers: new Map<string, Set<RuntimeConnection>>(),
      toConnectionInfo: () => {
        throw new Error('not used by broadcastToChannel');
      },
      sendThroughPipeline: () => {
        throw new Error('not used by broadcastToChannel');
      },
      openSharedSend: () => {
        throw new Error('not used by broadcastToChannel');
      },
    };
  }

  it('runs the before and after hooks once for a top-level broadcast that reaches nobody', () => {
    const before = vi.fn();
    const after = vi.fn();
    const runtime = createRuntime({
      livethingStampHooks: [() => ({ deliverySeq: 5, messageId: 'm5' })],
      beforeBroadcastHooks: [before],
      afterBroadcastHooks: [after],
    });
    const sender = createConnection('sender');

    broadcastToConnections(runtime, [sender], {
      event: 'foo',
      payload: { a: 1 },
      excludeConnectionId: 'sender',
    });

    expect(sender.descriptor.send).not.toHaveBeenCalled();
    expect(before).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
    expect(before.mock.calls[0]![0]).toEqual({
      event: 'foo',
      payload: { a: 1 },
      livething: { deliverySeq: 5, messageId: 'm5' },
    });
  });

  it('runs the hooks once for a channel broadcast with no live member', () => {
    const before = vi.fn();
    const runtime = channelRuntime({ beforeBroadcastHooks: [before] });

    broadcastToChannel(runtime, {
      channelName: 'general',
      channelFamily: null,
      event: 'foo',
      payload: {},
      excludeConnectionId: undefined,
    });

    expect(before).toHaveBeenCalledTimes(1);
    expect(before.mock.calls[0]![0].livething).toMatchObject({ channel: 'general' });
  });

  it('runs the hooks once, not per member, when many members receive it', () => {
    const before = vi.fn();
    const runtime = channelRuntime({ beforeBroadcastHooks: [before] });
    const a = member(runtime.channelMembers, 'a');
    const b = member(runtime.channelMembers, 'b');

    broadcastToChannel(runtime, {
      channelName: 'general',
      channelFamily: null,
      event: 'foo',
      payload: {},
      excludeConnectionId: undefined,
    });

    expect(before).toHaveBeenCalledTimes(1);
    expect(a.descriptor.send).toHaveBeenCalledTimes(1);
    expect(b.descriptor.send).toHaveBeenCalledTimes(1);
  });

  it('sends to nobody and logs once when a before-broadcast hook throws', () => {
    const errors: string[] = [];
    const runtime = channelRuntime({
      beforeBroadcastHooks: [
        () => {
          throw new Error('disk full');
        },
      ],
      logger: { warn() {}, error: (message: string) => errors.push(message) },
    });
    const a = member(runtime.channelMembers, 'a');

    broadcastToChannel(runtime, {
      channelName: 'general',
      channelFamily: null,
      event: 'foo',
      payload: {},
      excludeConnectionId: undefined,
    });

    expect(a.descriptor.send).not.toHaveBeenCalled();
    expect(errors).toEqual(['[livething] before-broadcast hook failed; no recipient received it']);
  });

  it('skips preparing a broadcast that reaches nobody when no broadcast hook is registered', () => {
    const stamp = vi.fn(() => ({}));
    const runtime = createRuntime({ livethingStampHooks: [stamp] });

    broadcastToConnections(runtime, [], { event: 'foo', payload: {} });

    expect(stamp).not.toHaveBeenCalled();
  });
});

describe('outgoing watch hook (outgoingHooks)', () => {
  function watching(seen: OutgoingFrame[], overrides: Partial<OutgoingRuntime> = {}) {
    return createRuntime({
      outgoingHooks: [{ handler: (frame) => void seen.push(frame), owner: APP_HOOK_OWNER }],
      ...overrides,
    });
  }

  it('sees a single send once, after it went out, with its target and recipient count', () => {
    const seen: OutgoingFrame[] = [];
    const connection = createConnection();
    const send = connection.descriptor.send as ReturnType<typeof vi.fn>;

    sendThroughPipeline(watching(seen), connection, {
      routing: undefined,
      event: 'foo',
      payload: { a: 1 },
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([
      {
        event: 'foo',
        payload: { a: 1 },
        owner: { kind: 'app' },
        channel: null,
        target: { kind: 'connection', id: 'c1' },
        recipients: 1,
      },
    ]);
  });

  it('cannot change the frame: a value it returns is ignored', () => {
    const runtime = createRuntime({
      outgoingHooks: [
        {
          handler: (() => ({
            hijacked: true,
          })) as unknown as OutgoingRuntime['outgoingHooks'][number]['handler'],
          owner: APP_HOOK_OWNER,
        },
      ],
    });
    const connection = createConnection();

    sendThroughPipeline(runtime, connection, {
      routing: undefined,
      event: 'foo',
      payload: { a: 1 },
    });

    const sent = JSON.parse(
      (connection.descriptor.send as ReturnType<typeof vi.fn>).mock.calls[0]![0].text as string,
    );
    expect(sent[1]).toEqual({ a: 1 });
  });

  it('logs a hook that throws instead of failing the send', () => {
    const errors: string[] = [];
    const runtime = createRuntime({
      outgoingHooks: [
        {
          handler: () => {
            throw new Error('metrics down');
          },
          owner: APP_HOOK_OWNER,
        },
      ],
      logger: { warn() {}, error: (message: string) => errors.push(message) },
    });
    const connection = createConnection();

    expect(
      sendThroughPipeline(runtime, connection, { routing: undefined, event: 'foo', payload: {} }),
    ).toBe(true);
    expect(errors).toEqual(['[livething] onOutgoing hook failed']);
  });

  it('counts zero recipients when the socket refused the frame', () => {
    const seen: OutgoingFrame[] = [];
    const connection = createConnection();
    (connection.descriptor.send as ReturnType<typeof vi.fn>).mockReturnValue(false);

    sendThroughPipeline(watching(seen), connection, {
      routing: undefined,
      event: 'foo',
      payload: {},
    });

    expect(seen[0]!.recipients).toBe(0);
  });

  it('does not show protocol frames', () => {
    const seen: OutgoingFrame[] = [];

    broadcastToConnections(watching(seen), [createConnection()], {
      event: '__memberChanges__',
      payload: { changes: [] },
    });

    expect(seen).toEqual([]);
  });

  it('sees a broadcast once, with every recipient counted', () => {
    const seen: OutgoingFrame[] = [];
    const sender = createConnection('sender');

    broadcastToConnections(watching(seen), [sender, createConnection('a'), createConnection('b')], {
      event: 'foo',
      payload: { a: 1 },
      excludeConnectionId: 'sender',
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ target: { kind: 'all' }, recipients: 2 });
  });

  it('sees a broadcast that reaches nobody, with zero recipients', () => {
    const seen: OutgoingFrame[] = [];

    broadcastToConnections(watching(seen), [], { event: 'foo', payload: {} });

    expect(seen).toEqual([expect.objectContaining({ target: { kind: 'all' }, recipients: 0 })]);
  });

  it('sees a user broadcast once, addressed to the user', () => {
    const seen: OutgoingFrame[] = [];

    const delivered = broadcastToUser(
      watching(seen),
      [createConnection('a'), createConnection('b')],
      {
        userId: 'u1',
        event: 'foo',
        payload: {},
      },
    );

    expect(delivered).toBe(2);
    expect(seen).toEqual([
      expect.objectContaining({ target: { kind: 'user', id: 'u1' }, recipients: 2 }),
    ]);
  });
});

describe('sendToConnections — one shared frame', () => {
  it('stamps once, writes the same bytes to every recipient, and shows the send once', () => {
    const seen: OutgoingFrame[] = [];
    let stamps = 0;
    const runtime = createRuntime({
      livethingStampHooks: [
        () => {
          stamps += 1;
          return { deliverySeq: stamps, messageId: `m${stamps}` };
        },
      ],
      outgoingHooks: [{ handler: (frame) => void seen.push(frame), owner: APP_HOOK_OWNER }],
    });
    const a = createConnection('a');
    const b = createConnection('b');

    const delivered = sendToConnections(runtime, [a, b], {
      routing: undefined,
      event: 'foo',
      payload: { a: 1 },
      target: { kind: 'tag', tagKind: 'ephemeral', group: 'role', key: 'admin' },
    });

    const frameA = (a.descriptor.send as ReturnType<typeof vi.fn>).mock.calls[0]![0].text;
    const frameB = (b.descriptor.send as ReturnType<typeof vi.fn>).mock.calls[0]![0].text;
    expect(delivered).toBe(2);
    expect(stamps).toBe(1);
    expect(frameA).toBe(frameB);

    expect(JSON.parse(frameA as string)[2]).toMatchObject({ delivery: { seq: 1, id: 'm1' } });
    expect(seen).toEqual([
      expect.objectContaining({
        target: { kind: 'tag', tagKind: 'ephemeral', group: 'role', key: 'admin' },
        recipients: 2,
      }),
    ]);
  });

  it('keeps sending to the rest when one peer throws', () => {
    const errors: string[] = [];
    const runtime = createRuntime({
      logger: { warn() {}, error: (message: string) => errors.push(message) },
    });
    const bad = createConnection('bad');
    (bad.descriptor.send as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('socket closed');
    });
    const good = createConnection('good');

    const delivered = sendToConnections(runtime, [bad, good], {
      routing: undefined,
      event: 'foo',
      payload: {},
      target: { kind: 'all' },
    });

    expect(delivered).toBe(1);
    expect(good.descriptor.send).toHaveBeenCalledTimes(1);
    expect(errors).toEqual(['[livething] send to one peer threw; continuing fanout']);
  });

  it('throws once for a payload no recipient could receive', () => {
    expect(() =>
      sendToConnections(createRuntime(), [createConnection()], {
        routing: undefined,
        event: 'foo',
        payload: [1],
        target: { kind: 'all' },
      }),
    ).toThrow(/plain object/);
  });

  it('adds a per-recipient field without stamping again', () => {
    let stamps = 0;
    const runtime = createRuntime({
      livethingStampHooks: [
        () => {
          stamps += 1;
          return { deliverySeq: stamps };
        },
      ],
    });
    const a = createConnection('a');
    const b = createConnection('b');
    const send = openSharedSend(runtime, {
      routing: { source: 'server' },
      event: 'ask',
      payload: {},
      target: { kind: 'all' },
    });

    send.deliver(a, { correlationId: 'x1' });
    send.deliver(b, { correlationId: 'x2' });
    send.finish();

    const metaA = JSON.parse(
      (a.descriptor.send as ReturnType<typeof vi.fn>).mock.calls[0]![0].text as string,
    )[2];
    const metaB = JSON.parse(
      (b.descriptor.send as ReturnType<typeof vi.fn>).mock.calls[0]![0].text as string,
    )[2];
    expect(stamps).toBe(1);
    expect(metaA).toMatchObject({ exchange: { id: 'x1', source: 'server' }, delivery: { seq: 1 } });
    expect(metaB).toMatchObject({ exchange: { id: 'x2', source: 'server' }, delivery: { seq: 1 } });
  });
});

describe('outgoing hooks from plugins', () => {
  function pluginOwner(id: string) {
    return { kind: 'plugin' as const, id };
  }

  // A correlationId bypasses the declaration check, so a hook's firing — not the
  // declaration — is what these tests observe.
  const requestRouting = { correlationId: 'corr-1' };

  it('runs a plugin hook for app and sibling plugin frames', () => {
    const seen: string[] = [];
    const runtime = createRuntime({
      outgoingHooks: [
        { handler: (frame) => void seen.push(frame.event), owner: pluginOwner('a:p') },
      ],
    });

    sendThroughPipeline(runtime, createConnection(), {
      routing: requestRouting,
      event: 'foo',
      payload: { a: 1 },
    });

    sendThroughPipeline(runtime, createConnection(), {
      routing: requestRouting,
      event: '__b:q::beat',
      payload: { a: 1 },
    });

    expect(seen).toEqual(['foo', '__b:q::beat']);
  });

  it('runs a plugin hook for its own frame with the SHORT declared name', () => {
    const seen: string[] = [];
    const runtime = createRuntime({
      outgoingHooks: [
        { handler: (frame) => void seen.push(frame.event), owner: pluginOwner('a:p') },
      ],
    });

    sendThroughPipeline(runtime, createConnection(), {
      routing: requestRouting,
      event: '__a:p::beat',
      payload: { a: 1 },
    });

    expect(seen).toEqual(['beat']);
  });

  it('keeps the owner for app and plugin frames', () => {
    const owners: OutgoingFrame['owner'][] = [];
    const events: string[] = [];
    const runtime = createRuntime({
      outgoingHooks: [
        {
          handler: (frame) => {
            owners.push(frame.owner);
            events.push(frame.event);
          },
          owner: pluginOwner('a:p'),
        },
      ],
    });

    sendThroughPipeline(runtime, createConnection(), {
      routing: requestRouting,
      event: 'foo',
      payload: { a: 1 },
    });
    sendThroughPipeline(runtime, createConnection(), {
      routing: requestRouting,
      event: '__a:p::beat',
      payload: { a: 1 },
    });

    expect(events).toEqual(['foo', 'beat']);
    expect(owners[0]).toEqual({ kind: 'app' });
    expect(owners[1]).toEqual({ kind: 'plugin', id: 'a:p' });
  });
});

describe('frameOwner', () => {
  it('returns app for a plain app event', () => {
    expect(frameOwner('chat-message')).toEqual({ kind: 'app' });
  });

  it('returns the plugin id for a plugin wire name', () => {
    expect(frameOwner('__some:plugin::evt')).toEqual({ kind: 'plugin', id: 'some:plugin' });
  });

  it('treats a protocol-shaped name with no :: as app-owned', () => {
    expect(frameOwner('__memberChanges__')).toEqual({ kind: 'app' });
  });
});
