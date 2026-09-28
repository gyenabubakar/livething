import { resolveChannel, routingFromLiveThing } from '~/_engine/runtime/scope.ts';
import { describe, expect, it } from 'vitest';
import type { CompiledServer } from '~/_engine/compile/types.ts';

describe('resolveChannel', () => {
  it('throws ChannelNotFound when channel targets an unregistered static channel', () => {
    const compiled = {
      channels: new Map(), // 'unknown-room' not registered
      channelFamilies: new Map(),
    } as unknown as CompiledServer;

    expect(() =>
      resolveChannel(compiled, { channel: 'unknown-room', channelFamily: null }),
    ).toThrowError(/channel-not-found/i);
  });

  it('throws ChannelNotFound when channelFamily targets an unregistered family', () => {
    const compiled = {
      channels: new Map(),
      channelFamilies: new Map(), // 'unknown-family' not registered
    } as unknown as CompiledServer;

    expect(() =>
      resolveChannel(compiled, { channel: 'room:1', channelFamily: 'unknown-family' }),
    ).toThrowError(/channel-not-found/i);
  });

  it('throws ChannelNotFound when channel does not match the family regex', () => {
    const compiled = {
      channels: new Map(),
      channelFamilies: new Map([
        [
          'rooms',
          {
            key: 'rooms',
            kind: 'channel' as const,
            pattern: { key: 'rooms', pattern: /^room:/ },
            outgoing: new Map(),
            incoming: new Map(),
            requests: new Map(),
            streams: new Map(),
            resumableStreams: new Map(),
            recordedStreams: new Map(),
            intercepts: [],
          },
        ],
      ]),
    } as unknown as CompiledServer;

    expect(() =>
      resolveChannel(compiled, { channel: 'admin', channelFamily: 'rooms' }),
    ).toThrowError(/channel-not-found/i);
  });

  it('returns the scope when channel matches the family regex', () => {
    const family = {
      key: 'rooms',
      kind: 'channel' as const,
      pattern: { key: 'rooms', pattern: /^room:/ },
      outgoing: new Map(),
      incoming: new Map(),
      requests: new Map(),
      streams: new Map(),
      resumableStreams: new Map(),
      recordedStreams: new Map(),
      intercepts: [],
    };

    const compiled = {
      channels: new Map(),
      channelFamilies: new Map([['rooms', family]]),
    } as unknown as CompiledServer;

    expect(resolveChannel(compiled, { channel: 'room:lobby', channelFamily: 'rooms' })).toEqual({
      channel: family,
      channelName: 'room:lobby',
      channelFamily: 'rooms',
    });
  });
});

describe('routingFromLiveThing', () => {
  it('keeps correlationId for a request frame', () => {
    expect(routingFromLiveThing({ correlationId: 'corr-1' })).toEqual({ correlationId: 'corr-1' });
  });

  it('keeps streamId for a stream-trigger frame', () => {
    expect(routingFromLiveThing({ streamId: 'stream-1' })).toEqual({ streamId: 'stream-1' });
  });

  it('keeps both streamId and streamNudgeId for a nudge frame', () => {
    expect(routingFromLiveThing({ streamId: 'stream-1', streamNudgeId: 'nudge-1' })).toEqual({
      streamId: 'stream-1',
      streamNudgeId: 'nudge-1',
    });
  });

  it('returns undefined when the block carries no routing ids', () => {
    expect(routingFromLiveThing({})).toBeUndefined();
    expect(routingFromLiveThing(undefined)).toBeUndefined();
  });
});
