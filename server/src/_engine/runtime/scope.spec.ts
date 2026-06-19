import { resolveScope, routingFromWSKit } from '~/_engine/runtime/scope.ts';
import { describe, expect, it } from 'vitest';
import type { CompiledServer } from '~/_engine/compile/types.ts';

describe('resolveScope', () => {
  it('throws ChannelNotFound when channel targets an unregistered static channel', () => {
    const compiled = {
      channels: new Map(), // 'unknown-room' not registered
      channelFamilies: new Map(),
    } as unknown as CompiledServer;

    expect(() =>
      resolveScope(compiled, { channel: 'unknown-room', channelScope: null }),
    ).toThrowError(/channel-not-found/i);
  });

  it('throws ChannelNotFound when channelScope targets an unregistered family', () => {
    const compiled = {
      channels: new Map(),
      channelFamilies: new Map(), // 'unknown-family' not registered
    } as unknown as CompiledServer;

    expect(() =>
      resolveScope(compiled, { channel: 'room:1', channelScope: 'unknown-family' }),
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

    expect(() => resolveScope(compiled, { channel: 'admin', channelScope: 'rooms' })).toThrowError(
      /channel-not-found/i,
    );
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

    expect(resolveScope(compiled, { channel: 'room:lobby', channelScope: 'rooms' })).toEqual({
      channel: family,
      channelName: 'room:lobby',
      channelScope: 'rooms',
    });
  });
});

describe('routingFromWSKit', () => {
  it('keeps correlationId for a request frame', () => {
    expect(routingFromWSKit({ correlationId: 'corr-1' })).toEqual({ correlationId: 'corr-1' });
  });

  it('keeps streamId for a stream-trigger frame', () => {
    expect(routingFromWSKit({ streamId: 'stream-1' })).toEqual({ streamId: 'stream-1' });
  });

  it('keeps both streamId and streamNudgeId for a nudge frame', () => {
    expect(routingFromWSKit({ streamId: 'stream-1', streamNudgeId: 'nudge-1' })).toEqual({
      streamId: 'stream-1',
      streamNudgeId: 'nudge-1',
    });
  });

  it('returns undefined when the block carries no routing ids', () => {
    expect(routingFromWSKit({})).toBeUndefined();
    expect(routingFromWSKit(undefined)).toBeUndefined();
  });
});
