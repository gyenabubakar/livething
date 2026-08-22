import { WSKitConfigError } from '@wskit/core';
import {
  acceptConnection,
  handleConnectionClose,
  wakeHibernatedConnection,
} from '~/_engine/runtime/connection.ts';
import { sendThroughPipeline } from '~/outgoing/runtime.ts';
import * as v from 'valibot';
import { describe, expect, it, vi } from 'vitest';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';
import { translator } from './translator.ts';

function runtime(overrides: Record<string, unknown> = {}) {
  let nextConnectionId = 0;
  return {
    compiled: {
      outgoing: new Map(),
      incoming: new Map(),
      requests: new Map(),
      streams: new Map(),
      resumableStreams: new Map(),
      recordedStreams: new Map(),
      intercepts: [],
      channels: new Map(),
      channelFamilies: new Map(),
      scheduled: new Map(),
      requires: {},
      replayClaimedChannelKeys: new Set(),
    },
    connections: new Map(),
    usersByKey: new Map(),
    channelMembers: new Map(),
    tagMembers: new Map(),
    wsToConnectionId: new Map(),
    generateId: () => `conn_${++nextConnectionId}`,
    persistAttachment: vi.fn(),
    buildConnectionContext: () => ({}),
    runConnectionLifecycle: async () => {},
    processTextMessage: vi.fn(async () => {}),
    handleConnectionClose: async () => {},
    handleRuntimeError: async () => {},
    outgoingHooks: [],
    wskitStampHooks: [],
    beforeSendHooks: [],
    afterSendHooks: [],
    waitUntil() {},
    logger: { warn: vi.fn(), error: vi.fn() },
    ...overrides,
  };
}

function descriptor(send = vi.fn(), close = vi.fn()) {
  return {
    send,
    close,
    bufferedAmount: () => 0,
    userId: 'user-1',
  };
}

describe('translation runtime', () => {
  it('creates one translator per connection and translates both directions', async () => {
    let factories = 0;
    const translate = translator(() => {
      factories += 1;
      let incoming = 0;
      return {
        inbound(raw) {
          incoming += 1;
          return `${raw}:${incoming}`;
        },
        outbound(outgoing) {
          return `foreign:${outgoing}`;
        },
      };
    });
    const engine = runtime({ translatorFactory: translate });
    const first = descriptor();
    const second = descriptor();

    const firstHandle = acceptConnection(engine as never, Symbol('first'), first);
    const secondHandle = acceptConnection(engine as never, Symbol('second'), second);
    await firstHandle.handleMessage('one');
    await firstHandle.handleMessage('two');
    await secondHandle.handleMessage('one');

    expect(factories).toBe(2);
    expect(engine.processTextMessage).toHaveBeenNthCalledWith(1, expect.anything(), 'one:1');
    expect(engine.processTextMessage).toHaveBeenNthCalledWith(2, expect.anything(), 'two:2');
    expect(engine.processTextMessage).toHaveBeenNthCalledWith(3, expect.anything(), 'one:1');

    const connection = [...engine.connections.values()][0]!;
    connection.descriptor.send('hello');
    expect(first.send).toHaveBeenCalledWith('foreign:hello');
  });

  it('does not run after-send hooks when the underlying socket send fails', () => {
    const afterSend = vi.fn();
    const engine = runtime({
      translatorFactory: translator(() => ({
        inbound: (raw) => raw,
        outbound: (outgoing) => outgoing,
      })),
      afterSendHooks: [afterSend],
    });
    engine.compiled.outgoing.set('message', { event: 'message' });
    const socket = descriptor(
      vi.fn(() => {
        throw new Error('socket closed');
      }),
    );

    acceptConnection(engine as never, Symbol('socket'), socket);
    const connection = [...engine.connections.values()][0]!;

    expect(() =>
      sendThroughPipeline(engine as never, connection as never, {
        routing: undefined,
        event: 'message',
        payload: {},
      }),
    ).toThrow('socket closed');
    expect(afterSend).not.toHaveBeenCalled();
    expect(socket.close).not.toHaveBeenCalled();
  });

  it('does not run after-send hooks when outbound translation fails', () => {
    const afterSend = vi.fn();
    const engine = runtime({
      translatorFactory: translator(() => ({
        inbound: (raw) => raw,
        outbound() {
          throw new Error('translator broke');
        },
      })),
      afterSendHooks: [afterSend],
    });
    engine.compiled.outgoing.set('message', { event: 'message' });
    const socket = descriptor();

    acceptConnection(engine as never, Symbol('socket'), socket);
    const connection = [...engine.connections.values()][0]!;

    expect(
      sendThroughPipeline(engine as never, connection as never, {
        routing: undefined,
        event: 'message',
        payload: {},
      }),
    ).toBe(false);
    expect(afterSend).not.toHaveBeenCalled();
    expect(socket.send).not.toHaveBeenCalled();
    expect(socket.close).toHaveBeenCalledWith(1011, '[wskit] translator failed');
  });

  it('persists outbound translator state when an adapter declines the frame', async () => {
    let sequence = 0;
    const persistAttachment = vi.fn();
    const engine = runtime({
      persistAttachment,
      translatorFactory: translator(() => ({
        inbound: (raw) => raw,
        outbound(outgoing) {
          sequence += 1;
          return outgoing;
        },
      })),
    });
    engine.compiled.outgoing.set('message', { event: 'message' });
    const socket = descriptor(vi.fn(() => false));
    const handle = acceptConnection(engine as never, Symbol('socket'), socket);
    await handle.handleMessage('foreign frame');
    const beforeOutbound = persistAttachment.mock.calls.length;
    const connection = [...engine.connections.values()][0]!;

    expect(
      sendThroughPipeline(engine as never, connection as never, {
        routing: undefined,
        event: 'message',
        payload: {},
      }),
    ).toBe(false);

    expect(sequence).toBe(1);
    expect(persistAttachment).toHaveBeenCalledTimes(beforeOutbound + 1);
  });

  it('flushes translator state before writing an outbound frame', async () => {
    const persistAttachment = vi.fn();
    const flushAttachment = vi.fn();
    const engine = runtime({
      persistAttachment,
      flushAttachment,
      translatorFactory: translator(() => ({
        inbound: (raw) => raw,
        outbound: (outgoing) => outgoing,
      })),
    });
    engine.compiled.outgoing.set('message', { event: 'message' });
    const socket = descriptor();
    const handle = acceptConnection(engine as never, Symbol('socket'), socket);
    await handle.handleMessage('foreign frame');
    const connection = [...engine.connections.values()][0]!;

    sendThroughPipeline(engine as never, connection as never, {
      routing: undefined,
      event: 'message',
      payload: {},
    });

    expect(flushAttachment).toHaveBeenCalledWith(connection);
    expect(socket.send).toHaveBeenCalledOnce();
  });

  it('does not write a frame when persisting translator state fails', async () => {
    let failPersistence = false;
    const afterSend = vi.fn();
    const engine = runtime({
      persistAttachment() {
        if (failPersistence) throw new Error('storage failed');
      },
      translatorFactory: translator(() => ({
        inbound: (raw) => raw,
        outbound: (outgoing) => outgoing,
      })),
      afterSendHooks: [afterSend],
    });
    engine.compiled.outgoing.set('message', { event: 'message' });
    const socket = descriptor();
    const handle = acceptConnection(engine as never, Symbol('socket'), socket);
    await handle.handleMessage('foreign frame');
    failPersistence = true;
    const connection = [...engine.connections.values()][0]!;

    expect(
      sendThroughPipeline(engine as never, connection as never, {
        routing: undefined,
        event: 'message',
        payload: {},
      }),
    ).toBe(false);

    expect(socket.send).not.toHaveBeenCalled();
    expect(afterSend).not.toHaveBeenCalled();
    expect(socket.close).toHaveBeenCalledWith(1011, '[wskit] translator failed');
  });

  it('does not write a frame before surfacing a translator persistence configuration error', async () => {
    const afterSend = vi.fn();
    let failPersistence = false;
    const engine = runtime({
      persistAttachment() {
        if (failPersistence) {
          throw new WSKitConfigError(
            'async callbacks are not supported (translator.hibernation.serialize).',
          );
        }
      },
      translatorFactory: translator(() => ({
        inbound: (raw) => raw,
        outbound: (outgoing) => outgoing,
      })),
      afterSendHooks: [afterSend],
    });
    engine.compiled.outgoing.set('message', { event: 'message' });
    const socket = descriptor();
    const handle = acceptConnection(engine as never, Symbol('socket'), socket);
    await handle.handleMessage('foreign frame');
    failPersistence = true;
    const connection = [...engine.connections.values()][0]!;

    expect(() =>
      sendThroughPipeline(engine as never, connection as never, {
        routing: undefined,
        event: 'message',
        payload: {},
      }),
    ).toThrow(WSKitConfigError);

    expect(socket.send).not.toHaveBeenCalled();
    expect(afterSend).not.toHaveBeenCalled();
    expect(socket.close).toHaveBeenCalledWith(1011, '[wskit] translator configuration failed');
  });

  it('does not close twice when a forced translator-state flush reports a configuration error', async () => {
    const socket = descriptor();
    const engine = runtime({
      flushAttachment(connection: { closing?: boolean; preserveStateOnClose?: boolean }) {
        connection.closing = true;
        connection.preserveStateOnClose = true;
        socket.close(1011, '[wskit] translator configuration failed');
        throw new WSKitConfigError('translator state is invalid');
      },
      translatorFactory: translator(() => ({
        inbound: (raw) => raw,
        outbound: (outgoing) => outgoing,
      })),
    });
    engine.compiled.outgoing.set('message', { event: 'message' });
    const handle = acceptConnection(engine as never, Symbol('socket'), socket);
    await handle.handleMessage('foreign frame');
    const connection = [...engine.connections.values()][0]!;

    expect(() =>
      sendThroughPipeline(engine as never, connection as never, {
        routing: undefined,
        event: 'message',
        payload: {},
      }),
    ).toThrow(WSKitConfigError);

    expect(socket.close).toHaveBeenCalledTimes(1);
  });

  it('closes invalid validator input before the WSKit message pipeline', async () => {
    const engine = runtime({
      translatorFactory: translator(() => ({
        input: v.object({ event: v.string() }),
        inbound(frame) {
          return frame.event;
        },
      })),
    });
    const socket = descriptor();
    const handle = acceptConnection(engine as never, Symbol('socket'), socket);

    await handle.handleMessage('{"event":1}');

    expect(socket.close).toHaveBeenCalledWith(1002, '[wskit] translator failed');
    expect(engine.processTextMessage).not.toHaveBeenCalled();
  });

  it('propagates translator configuration errors and closes live sockets', async () => {
    const factoryEngine = runtime({
      translatorFactory: () => Promise.resolve({ inbound: (raw: string) => raw }),
    });
    const factorySocket = descriptor();
    expect(() =>
      acceptConnection(factoryEngine as never, Symbol('factory'), factorySocket),
    ).toThrow(WSKitConfigError);

    const inboundEngine = runtime({
      translatorFactory: translator(() => ({ inbound: () => 42 }) as never),
    });
    const inboundSocket = descriptor();
    const inboundHandle = acceptConnection(
      inboundEngine as never,
      Symbol('inbound'),
      inboundSocket,
    );
    await expect(inboundHandle.handleMessage('foreign frame')).rejects.toThrow(WSKitConfigError);

    const outboundEngine = runtime({
      translatorFactory: translator(
        () => ({ inbound: (raw: string) => raw, outbound: () => 42 }) as never,
      ),
    });
    const outboundSocket = descriptor();
    acceptConnection(outboundEngine as never, Symbol('outbound'), outboundSocket);
    const outboundConnection = [...outboundEngine.connections.values()][0]!;
    expect(() => outboundConnection.descriptor.send('frame')).toThrow(WSKitConfigError);

    expect(inboundSocket.close).toHaveBeenCalledWith(
      1011,
      '[wskit] translator configuration failed',
    );
    expect(outboundSocket.close).toHaveBeenCalledWith(
      1011,
      '[wskit] translator configuration failed',
    );
    expect(factorySocket.close).toHaveBeenCalledWith(
      1011,
      '[wskit] translator configuration failed',
    );
  });

  it('keeps hibernation state when a live config-error close is cleaned up', async () => {
    const deleteConnectionState = vi.fn();
    const engine = runtime({
      hibernationEnabled: true,
      translatorFactory: translator(() => ({ inbound: () => 42 }) as never),
      deleteConnectionState,
      cancelActiveStreamsForConnection: async () => {},
      leaveChannel: async () => {},
    });
    const socket = descriptor();
    const handle = acceptConnection(engine as never, Symbol('socket'), socket);
    const connection = [...engine.connections.values()][0]!;

    await expect(handle.handleMessage('foreign frame')).rejects.toThrow(WSKitConfigError);
    await handleConnectionClose(engine as never, {
      connection,
      code: 1011,
      reason: '[wskit] translator configuration failed',
    });

    expect(engine.connections.has(connection.id)).toBe(false);
    expect(deleteConnectionState).not.toHaveBeenCalled();
  });

  it('closes a waking socket before propagating a restore configuration error', () => {
    const deleteConnectionState = vi.fn();
    const engine = runtime({
      hibernationEnabled: true,
      translatorFactory: translator(
        () =>
          ({
            inbound: (raw: string) => raw,
            hibernation: {
              serialize: () => ({}),
              restore: () => Promise.resolve(),
            },
          }) as never,
      ),
      restoreAttachment: () => ({ id: 'conn_saved' }),
      readConnectionState: () => ({
        connection_id: 'conn_saved',
        user_id: 'user-1',
        meta: {},
        ephemeral_tags: [],
        ephemeral_memberships: [],
        active_stream_ids: [],
        translator_state: {},
        metadata: {},
      }),
      deleteConnectionState,
      reloadPersistentTags: () => {},
    });
    const socket = descriptor();

    expect(() => wakeHibernatedConnection(engine as never, socket as never)).toThrow(
      WSKitConfigError,
    );
    expect(socket.close).toHaveBeenCalledWith(1011, '[wskit] translator configuration failed');
    expect(deleteConnectionState).not.toHaveBeenCalled();
  });

  it('closes a waking socket when the translator factory is misconfigured', () => {
    const engine = runtime({
      hibernationEnabled: true,
      translatorFactory: () => Promise.resolve({ inbound: (raw: string) => raw }),
    });
    const socket = descriptor();

    expect(() => wakeHibernatedConnection(engine as never, socket as never)).toThrow(
      WSKitConfigError,
    );
    expect(socket.close).toHaveBeenCalledWith(1011, '[wskit] translator configuration failed');
  });

  it('closes a waking socket when adapter hibernation restore is asynchronous', () => {
    const engine = runtime({
      hibernationEnabled: true,
      restoreAttachment: () => Promise.resolve({ id: 'conn_saved' }),
    });
    const socket = descriptor();

    expect(() => wakeHibernatedConnection(engine as never, socket as never)).toThrow(
      WSKitConfigError,
    );
    expect(socket.close).toHaveBeenCalledWith(1011, '[wskit] hibernation restore failed');
  });

  it('closes a waking socket when its restored connection ID is already live', () => {
    const engine = runtime({
      hibernationEnabled: true,
      connections: new Map([['conn_saved', {}]]),
      restoreAttachment: () => ({ id: 'conn_saved' }),
      readConnectionState: () => ({
        connection_id: 'conn_saved',
        user_id: 'user-1',
        meta: {},
        ephemeral_tags: [],
        ephemeral_memberships: [],
        active_stream_ids: [],
        metadata: {},
      }),
    });
    const socket = descriptor();

    expect(() => wakeHibernatedConnection(engine as never, socket as never)).toThrow(
      /duplicate connection id/,
    );
    expect(socket.close).toHaveBeenCalledWith(1011, '[wskit] duplicate hibernation connection id');
  });

  it('restores translator state before translating a wake-time stream error', () => {
    const restored: unknown[] = [];
    const order: string[] = [];
    const flushAttachment = vi.fn((connection: RuntimeConnection) => {
      order.push('flush');
      return connection;
    });
    const engine = runtime({
      hibernationEnabled: true,
      flushAttachment,
      translatorFactory: translator(() => ({
        inbound: (raw) => raw,
        outbound: (outgoing) => `foreign:${outgoing}`,
        hibernation: {
          serialize: () => ({ cursor: 0 }),
          restore: (state) => void restored.push(state),
        },
      })),
      restoreAttachment: () => ({ id: 'conn_saved' }),
      readConnectionState: () => ({
        connection_id: 'conn_saved',
        user_id: 'user-1',
        meta: {},
        ephemeral_tags: [{ group: 'role', key: 'member' }],
        ephemeral_memberships: [{ channelName: 'room:general', channelFamily: 'rooms' }],
        active_stream_ids: ['stream_1'],
        translator_state: { cursor: 4 },
        metadata: {},
      }),
      reloadPersistentTags: () => {},
    });
    const socket = descriptor(vi.fn(() => void order.push('send')));

    wakeHibernatedConnection(engine as never, socket as never);

    expect(restored).toEqual([{ cursor: 4 }]);
    expect(socket.send).toHaveBeenCalledWith(expect.stringMatching(/^foreign:/));
    expect(order).toEqual(['flush', 'send']);
    const flushedConnection = flushAttachment.mock.calls[0]?.[0];
    expect(flushedConnection?.tags.ephemeral).toEqual(new Map([['role', new Set(['member'])]]));
    expect(flushedConnection?.channelMemberships).toEqual(
      new Map([
        ['["rooms","room:general"]', { channelName: 'room:general', channelFamily: 'rooms' }],
      ]),
    );
  });

  it('keeps a waking connection live when an orphaned stream error is declined', async () => {
    const flushAttachment = vi.fn();
    const engine = runtime({
      hibernationEnabled: true,
      flushAttachment,
      translatorFactory: translator(() => ({
        inbound: (raw) => raw,
        outbound: (outgoing) => outgoing,
      })),
      restoreAttachment: () => ({ id: 'conn_saved' }),
      readConnectionState: () => ({
        connection_id: 'conn_saved',
        user_id: 'user-1',
        meta: {},
        ephemeral_tags: [],
        ephemeral_memberships: [],
        active_stream_ids: ['stream_1'],
        metadata: {},
      }),
      reloadPersistentTags: () => {},
    });
    const socket = descriptor(vi.fn(() => false));

    const handle = wakeHibernatedConnection(engine as never, socket as never);
    const connection = engine.connections.get('conn_saved');

    expect(connection).toBeDefined();
    expect(connection?.activeStreamIds).toEqual(new Set(['stream_1']));
    expect(flushAttachment).toHaveBeenCalledWith(connection);
    expect(socket.close).not.toHaveBeenCalled();

    await handle.handleMessage('foreign frame');
    expect(engine.processTextMessage).toHaveBeenCalledWith(connection, 'foreign frame');
  });

  it('restores translator state before inbound translation after wake', async () => {
    let sequence = 0;
    const engine = runtime({
      hibernationEnabled: true,
      translatorFactory: translator(() => ({
        inbound(raw) {
          return `${raw}:${++sequence}`;
        },
        hibernation: {
          serialize() {
            return { sequence };
          },
          restore(state) {
            sequence = state?.sequence ?? 0;
          },
        },
      })),
      restoreAttachment: () => ({ id: 'conn_saved' }),
      readConnectionState: () => ({
        connection_id: 'conn_saved',
        user_id: 'user-1',
        meta: {},
        ephemeral_tags: [],
        ephemeral_memberships: [],
        active_stream_ids: [],
        translator_state: { sequence: 4 },
        metadata: {},
      }),
      reloadPersistentTags: () => {},
    });
    const socket = descriptor();
    const handle = wakeHibernatedConnection(engine as never, socket as never);

    await handle.handleMessage('foreign frame');

    expect(engine.processTextMessage).toHaveBeenCalledWith(expect.anything(), 'foreign frame:5');
  });
});
