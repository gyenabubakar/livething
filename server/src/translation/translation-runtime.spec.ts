import { acceptConnection, wakeHibernatedConnection } from '~/_engine/runtime/connection.ts';
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
    logger: { error: vi.fn() },
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
