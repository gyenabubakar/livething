import { WSKitConfigError } from '@wskit/core';
import {
  acceptConnection,
  handleConnectionClose,
  wakeHibernatedConnection,
} from '~/_engine/runtime/connection.ts';
import { sendThroughPipeline } from '~/outgoing/runtime.ts';
import * as v from 'valibot';
import { describe, expect, it, vi } from 'vitest';
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

    expect(factorySocket.close).not.toHaveBeenCalled();
    expect(inboundSocket.close).toHaveBeenCalledWith(
      1011,
      '[wskit] translator configuration failed',
    );
    expect(outboundSocket.close).toHaveBeenCalledWith(
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

  it('propagates a hibernation restore configuration error without deleting state', () => {
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
    expect(socket.close).not.toHaveBeenCalled();
    expect(deleteConnectionState).not.toHaveBeenCalled();
  });

  it('restores translator state before translating a wake-time stream error', () => {
    const restored: unknown[] = [];
    const engine = runtime({
      hibernationEnabled: true,
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
        ephemeral_tags: [],
        ephemeral_memberships: [],
        active_stream_ids: ['stream_1'],
        translator_state: { cursor: 4 },
        metadata: {},
      }),
      reloadPersistentTags: () => {},
    });
    const socket = descriptor();

    wakeHibernatedConnection(engine as never, socket as never);

    expect(restored).toEqual([{ cursor: 4 }]);
    expect(socket.send).toHaveBeenCalledWith(expect.stringMatching(/^foreign:/));
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
