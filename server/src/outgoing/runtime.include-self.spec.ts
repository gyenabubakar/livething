import { addChannelMembership } from '~/channel/runtime.ts';
import { broadcastToChannel, broadcastToConnections } from '~/outgoing/runtime.ts';
import { describe, expect, it, vi } from 'vitest';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';
import type { OutgoingRuntime } from '~/outgoing/runtime.ts';

function createConnection(id: string): RuntimeConnection {
  return {
    id,
    userId: id,
    wsKey: Symbol(id),
    descriptor: {
      send: vi.fn(),
      close() {},
      bufferedAmount() {
        return 0;
      },
      userId: id,
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
      channels: new Map(),
      channelFamilies: new Map(),
    } as unknown as OutgoingRuntime['compiled'],
    outgoingHooks: [],
    wskitStampHooks: [],
    beforeSendHooks: [],
    afterSendHooks: [],
    waitUntil() {},
    logger: { warn() {}, error() {} },
    generateId: () => 'id_1',
    ...overrides,
  };
}

function sentTo(connection: RuntimeConnection): boolean {
  return (connection.descriptor.send as ReturnType<typeof vi.fn>).mock.calls.length > 0;
}

describe('broadcastToConnections — includeSelf (defaults to false)', () => {
  it('omitting includeSelf excludes the sender by default', () => {
    const runtime = createRuntime();
    const sender = createConnection('sender');
    const other = createConnection('other');

    broadcastToConnections(runtime, [sender, other], {
      event: 'foo',
      payload: {},
      excludeConnectionId: sender.id,
    });

    expect(sentTo(sender)).toBe(false);
    expect(sentTo(other)).toBe(true);
  });

  it('includeSelf: false is identical to omitting it', () => {
    const runtime = createRuntime();
    const sender = createConnection('sender');
    const other = createConnection('other');

    broadcastToConnections(runtime, [sender, other], {
      event: 'foo',
      payload: {},
      excludeConnectionId: sender.id,
      options: { includeSelf: false },
    });

    expect(sentTo(sender)).toBe(false);
    expect(sentTo(other)).toBe(true);
  });

  it('includeSelf: true delivers to the sender as well', () => {
    const runtime = createRuntime();
    const sender = createConnection('sender');
    const other = createConnection('other');

    broadcastToConnections(runtime, [sender, other], {
      event: 'foo',
      payload: {},
      excludeConnectionId: sender.id,
      options: { includeSelf: true },
    });

    expect(sentTo(sender)).toBe(true);
    expect(sentTo(other)).toBe(true);
  });
});

describe('broadcastToChannel — includeSelf (replaces excludeSelf, default flipped to false)', () => {
  it('omitting includeSelf excludes the sender from the channel broadcast by default', () => {
    const channelMembers = new Map<string, Set<RuntimeConnection>>();
    const runtime = {
      ...createRuntime({
        compiled: {
          outgoing: new Map([['foo', { event: 'foo' }]]),
          streams: new Map(),
          resumableStreams: new Map(),
          recordedStreams: new Map(),
          channels: new Map([['room', { outgoing: new Map([['foo', { event: 'foo' }]]) }]]),
          channelFamilies: new Map(),
        } as unknown as OutgoingRuntime['compiled'],
      }),
      channelMembers,
    };
    const sender = createConnection('sender');
    const other = createConnection('other');
    addChannelMembership(runtime.channelMembers, sender, {
      channelName: 'room',
      channelFamily: null,
    });
    addChannelMembership(runtime.channelMembers, other, {
      channelName: 'room',
      channelFamily: null,
    });

    broadcastToChannel(runtime as never, {
      channelName: 'room',
      event: 'foo',
      payload: {},
      excludeConnectionId: sender.id,
      channelFamily: null,
    });

    expect(sentTo(sender)).toBe(false);
    expect(sentTo(other)).toBe(true);
  });

  it('includeSelf: true reaches every member including the sender', () => {
    const channelMembers = new Map<string, Set<RuntimeConnection>>();
    const runtime = {
      ...createRuntime({
        compiled: {
          outgoing: new Map([['foo', { event: 'foo' }]]),
          streams: new Map(),
          resumableStreams: new Map(),
          recordedStreams: new Map(),
          channels: new Map([['room', { outgoing: new Map([['foo', { event: 'foo' }]]) }]]),
          channelFamilies: new Map(),
        } as unknown as OutgoingRuntime['compiled'],
      }),
      channelMembers,
    };
    const sender = createConnection('sender');
    const other = createConnection('other');
    addChannelMembership(runtime.channelMembers, sender, {
      channelName: 'room',
      channelFamily: null,
    });
    addChannelMembership(runtime.channelMembers, other, {
      channelName: 'room',
      channelFamily: null,
    });

    broadcastToChannel(runtime as never, {
      channelName: 'room',
      event: 'foo',
      payload: {},
      excludeConnectionId: sender.id,
      channelFamily: null,
      includeSelf: true,
    });

    expect(sentTo(sender)).toBe(true);
    expect(sentTo(other)).toBe(true);
  });
});
