import { resolveScope } from '~/_engine/runtime/scope.ts';
import { describe, expect, it } from 'vitest';
import type { CompiledServer } from '~/_engine/compile/types.ts';

describe('resolveScope', () => {
  it('throws NamespaceNotFound when namespace targets an unregistered namespace', () => {
    const compiled = {
      namespaces: new Map(),
      channels: new Map(),
      channelFamilies: new Map(),
    } as unknown as CompiledServer;

    expect(() => resolveScope(compiled, { namespace: 'typo', channelScope: null })).toThrowError(
      /namespace-not-found/i,
    );
  });

  it('throws InvalidScopeMarkers when both namespace and channel are set', () => {
    const compiled = {
      namespaces: new Map([['admin', { name: 'admin' }]]),
      channels: new Map([['private-room', { pattern: 'private-room' }]]),
      channelFamilies: new Map(),
    } as unknown as CompiledServer;

    expect(() =>
      resolveScope(compiled, { namespace: 'admin', channel: 'private-room', channelScope: null }),
    ).toThrowError(/invalid-scope-markers/i);
  });

  it('throws ChannelNotFound when channel targets an unregistered static channel', () => {
    const compiled = {
      namespaces: new Map(),
      channels: new Map(), // 'unknown-room' not registered
      channelFamilies: new Map(),
    } as unknown as CompiledServer;

    expect(() =>
      resolveScope(compiled, { channel: 'unknown-room', channelScope: null }),
    ).toThrowError(/channel-not-found/i);
  });

  it('throws ChannelNotFound when channelScope targets an unregistered family', () => {
    const compiled = {
      namespaces: new Map(),
      channels: new Map(),
      channelFamilies: new Map(), // 'unknown-family' not registered
    } as unknown as CompiledServer;

    expect(() =>
      resolveScope(compiled, { channel: 'room:1', channelScope: 'unknown-family' }),
    ).toThrowError(/channel-not-found/i);
  });

  it('throws ChannelNotFound when channel does not match the family regex', () => {
    const compiled = {
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
      namespaces: new Map(),
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
