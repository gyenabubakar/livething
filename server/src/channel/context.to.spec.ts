import { buildChannelHandle } from '~/channel/context.ts';
import { describe, expect, it, vi } from 'vitest';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';
import type { SendThroughPipelineOptions } from '~/outgoing/runtime.ts';

function createConnection(id: string, userId: string): RuntimeConnection {
  return {
    id,
    userId,
    wsKey: Symbol(id),
    descriptor: { send() {}, close() {}, bufferedAmount: () => 0, identity: userId },
    meta: {},
    tags: { ephemeral: new Map(), persistent: new Map() },
    channelMemberships: new Map(),
    latency: null,
    quality: 'good',
  };
}

const scope = { channelName: 'room:general', channelFamily: null };

describe('buildChannelHandle().send — the `to` option', () => {
  it('with no `to`, sends through the pipeline to the calling connection and returns 1 when delivered', () => {
    const caller = createConnection('caller', 'u1');
    const pipelineCalls: unknown[] = [];
    const handle = buildChannelHandle(caller, scope, {
      sendThroughPipeline: (conn: RuntimeConnection, opts: SendThroughPipelineOptions) => {
        pipelineCalls.push({ connId: conn.id, opts });
        return true;
      },
      sendToChannelRecipient: vi.fn(),
      broadcastToChannel: vi.fn(),
      getChannelMembers: vi.fn(),
      kickChannelMembers: vi.fn(),
      subscribeConnectionAsServer: vi.fn(),
    } as never);

    const delivered = handle.send('ping', { n: 1 });

    expect(delivered).toBe(1);
    expect(pipelineCalls).toEqual([
      {
        connId: 'caller',
        opts: {
          routing: { channel: 'room:general', channelFamily: null },
          event: 'ping',
          payload: { n: 1 },
        },
      },
    ]);
  });

  it('with no `to`, returns 0 when the pipeline reports it did not deliver', () => {
    const caller = createConnection('caller', 'u1');
    const handle = buildChannelHandle(caller, scope, {
      sendThroughPipeline: () => false,
      sendToChannelRecipient: vi.fn(),
      broadcastToChannel: vi.fn(),
      getChannelMembers: vi.fn(),
      kickChannelMembers: vi.fn(),
      subscribeConnectionAsServer: vi.fn(),
    } as never);

    expect(handle.send('ping', {})).toBe(0);
  });

  it('with `to`, delegates to sendToChannelRecipient (channel-scoped) and returns its delivered count', () => {
    const caller = createConnection('caller', 'u1');
    const to = { __wskit: 'user-ref' as const, id: 'bob', instance: undefined };
    const sendToChannelRecipient = vi.fn(() => 3);
    const handle = buildChannelHandle(caller, scope, {
      sendThroughPipeline: vi.fn(),
      sendToChannelRecipient,
      broadcastToChannel: vi.fn(),
      getChannelMembers: vi.fn(),
      kickChannelMembers: vi.fn(),
      subscribeConnectionAsServer: vi.fn(),
    } as never);

    const delivered = handle.send('ping', { n: 2 }, { to });

    expect(delivered).toBe(3);
    expect(sendToChannelRecipient).toHaveBeenCalledWith({
      channelName: 'room:general',
      channelFamily: null,
      to,
      event: 'ping',
      payload: { n: 2 },
    });
  });

  it('a `to` recipient that resolves to nobody returns 0 without touching the pipeline', () => {
    const caller = createConnection('caller', 'u1');
    const pipeline = vi.fn();
    const to = { __wskit: 'user-ref' as const, id: 'nobody', instance: undefined };
    const handle = buildChannelHandle(caller, scope, {
      sendThroughPipeline: pipeline,
      sendToChannelRecipient: () => 0,
      broadcastToChannel: vi.fn(),
      getChannelMembers: vi.fn(),
      kickChannelMembers: vi.fn(),
      subscribeConnectionAsServer: vi.fn(),
    } as never);

    expect(handle.send('ping', {}, { to })).toBe(0);
    expect(pipeline).not.toHaveBeenCalled();
  });
});

describe('buildChannelHandle().broadcast — includeSelf', () => {
  it('omitting includeSelf still excludes the caller (excludeConnectionId is set)', () => {
    const caller = createConnection('caller', 'u1');
    const broadcastToChannel = vi.fn();
    const handle = buildChannelHandle(caller, scope, {
      sendThroughPipeline: vi.fn(),
      sendToChannelRecipient: vi.fn(),
      broadcastToChannel,
      getChannelMembers: vi.fn(),
      kickChannelMembers: vi.fn(),
      subscribeConnectionAsServer: vi.fn(),
    } as never);

    handle.broadcast('news', { text: 'hi' });

    expect(broadcastToChannel).toHaveBeenCalledWith({
      channelName: 'room:general',
      event: 'news',
      payload: { text: 'hi' },
      excludeConnectionId: 'caller',
      channelFamily: null,
      includeSelf: undefined,
    });
  });

  it('includeSelf: true is forwarded through so the caller is also delivered to', () => {
    const caller = createConnection('caller', 'u1');
    const broadcastToChannel = vi.fn();
    const handle = buildChannelHandle(caller, scope, {
      sendThroughPipeline: vi.fn(),
      sendToChannelRecipient: vi.fn(),
      broadcastToChannel,
      getChannelMembers: vi.fn(),
      kickChannelMembers: vi.fn(),
      subscribeConnectionAsServer: vi.fn(),
    } as never);

    handle.broadcast('news', { text: 'hi' }, { includeSelf: true });

    expect(broadcastToChannel).toHaveBeenCalledWith(
      expect.objectContaining({ includeSelf: true, excludeConnectionId: 'caller' }),
    );
  });
});
