import { broadcastToChannel, dispatchIncoming, resolveScope } from '~/_engine/runtime/messages.ts';
import { describe, expect, it, vi } from 'vitest';

function createConnection(id: string) {
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
    channelMemberships: new Map<string, { channelName: string; channelScope?: string }>(),
    latency: null,
    quality: 'good' as const,
  };
}

function addMembership(
  connection: ReturnType<typeof createConnection>,
  channelName: string,
  channelScope?: string,
) {
  connection.channels.add(channelName);
  connection.channelMemberships.set(`${channelScope ?? ''}::${channelName}`, {
    channelName,
    channelScope,
  });
}

describe('message runtime', () => {
  it('broadcastToChannel only targets members of the matching channel scope', () => {
    const roomsMember = createConnection('rooms');
    const lobbiesMember = createConnection('lobbies');

    addMembership(roomsMember, 'room:general', 'rooms');
    addMembership(lobbiesMember, 'room:general', 'lobbies');

    const runtime = {
      connections: new Map([
        [roomsMember.id, roomsMember],
        [lobbiesMember.id, lobbiesMember],
      ]),
      compiled: {
        outgoing: new Map([['message', { event: 'message' }]]),
        streams: new Map(),
        channels: new Map(),
        channelFamilies: new Map([
          [
            'rooms',
            {
              key: 'rooms',
              kind: 'channel' as const,
              pattern: { key: 'rooms', pattern: /^room:/ },
              outgoing: new Map([['message', { event: 'message' }]]),
              incoming: new Map(),
              requests: new Map(),
              streams: new Map(),
              preIntercepts: [],
              postIntercepts: new Map(),
            },
          ],
        ]),
      },
      moduleRuntimes: [],
      outgoingHooks: [],
      beforeSendHooks: [],
      afterSendHooks: [],
      waitUntil() {},
      logger: {
        warn() {},
        error() {},
      },
      generateId() {
        return 'id_1';
      },
      toConnectionInfo() {
        throw new Error('unused');
      },
    } as const;

    broadcastToChannel(
      runtime as any,
      'room:general',
      'message',
      { text: 'hi' },
      undefined,
      'rooms',
    );

    expect(roomsMember.descriptor.send).toHaveBeenCalledTimes(1);
    expect(lobbiesMember.descriptor.send).not.toHaveBeenCalled();
  });

  it('drops incoming channel traffic when only a same-name membership exists in another scope', async () => {
    const handler = vi.fn();
    const connection = createConnection('conn_1');
    addMembership(connection, 'room:general', 'lobbies');

    const runtime = {
      compiled: {
        outgoing: new Map(),
        incoming: new Map(),
        requests: new Map(),
        streams: new Map(),
        preIntercepts: [],
        postIntercepts: new Map(),
        namespaces: new Map(),
        channels: new Map(),
        channelFamilies: new Map([
          [
            'rooms',
            {
              key: 'rooms',
              kind: 'channel' as const,
              pattern: { key: 'rooms', pattern: /^room:/ },
              outgoing: new Map(),
              incoming: new Map([['message', { event: 'message', handler, validator: undefined }]]),
              requests: new Map(),
              streams: new Map(),
              preIntercepts: [],
              postIntercepts: new Map(),
            },
          ],
        ]),
        scheduled: new Map(),
        modules: [],
        requires: {},
      },
      connections: new Map([[connection.id, connection]]),
      toConnectionInfo() {
        throw new Error('unused');
      },
      activeStreams: new Map(),
      protocolHandlers: new Map(),
      incomingHooks: [],
      moduleRuntimes: [],
      errorHooks: [],
      requireTimers() {
        return {
          setTimeout() {
            return undefined;
          },
          clearTimeout() {},
        };
      },
      buildConnectionContext() {
        return { id: connection.id };
      },
      sendProtocolMessage() {},
      sendReplay() {},
      persistAttachment() {},
      setActiveConnectionId() {},
      async handleRuntimeError() {},
      async handleValidationError() {},
      async handleSubscribe() {},
      async handleUnsubscribe() {},
      waitUntil() {},
      generateId() {
        return 'id_1';
      },
    } as const;

    expect(
      resolveScope(runtime.compiled as any, { _channel: 'room:general', _channelScope: 'rooms' }),
    ).toEqual({
      channel: runtime.compiled.channelFamilies.get('rooms'),
      channelName: 'room:general',
      channelScope: 'rooms',
    });

    await dispatchIncoming(runtime as any, connection as any, 'message', {
      _channel: 'room:general',
      _channelScope: 'rooms',
      text: 'hi',
    });

    expect(handler).not.toHaveBeenCalled();
  });
});
