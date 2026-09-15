/* oxlint-disable @typescript-eslint/no-explicit-any */
import { frameMatches, frameUnsafeCast } from '~/intercept/frame-match.ts';
import { scopePluginContext } from '~/plugin-scope.ts';
import { describe, expect, it, vi } from 'vitest';
import type { InterceptFrame } from '~/intercept/intercept.ts';

const ID = 'acme:feed';

describe('scopePluginContext — sendReplay (S1)', () => {
  it('namespaces the event on ctx.sendReplay and ctx.channel.sendReplay', () => {
    const sendReplay = vi.fn();
    const channelSendReplay = vi.fn();
    const scoped = scopePluginContext(ID, {
      sendReplay,
      channel: { sendReplay: channelSendReplay },
    });

    scoped.sendReplay('feed', { n: 1 }, { wire: true });
    expect(sendReplay).toHaveBeenCalledWith('__acme:feed::feed', { n: 1 }, { wire: true });

    scoped.channel.sendReplay('feed', { n: 1 }, { wire: true });
    expect(channelSendReplay).toHaveBeenCalledWith('__acme:feed::feed', { n: 1 }, { wire: true });
  });

  it('does not invent optional send-like methods', () => {
    const scoped = scopePluginContext(ID, {});

    expect(scoped.request).toBeUndefined();
    expect(scoped.broadcastRequest).toBeUndefined();
    expect(scoped.sendReplay).toBeUndefined();
  });
});

describe('scopePluginContext — channel broadcastTo', () => {
  it('namespaces broadcastTo event names without changing the recipient', () => {
    const channelBroadcastTo = vi.fn();
    const handleBroadcastTo = vi.fn();
    const target = { __wskit: 'user-ref', id: 'u1' };
    const scoped = scopePluginContext(ID, {
      channel: { broadcastTo: channelBroadcastTo },
      channels: { get: () => ({ broadcastTo: handleBroadcastTo }) },
    });

    scoped.channel.broadcastTo(target, 'feed', { n: 1 });
    scoped.channels.get('room').broadcastTo(target, 'feed', { n: 2 });

    expect(channelBroadcastTo).toHaveBeenCalledWith(target, '__acme:feed::feed', { n: 1 });
    expect(handleBroadcastTo).toHaveBeenCalledWith(target, '__acme:feed::feed', { n: 2 });
  });
});

describe('scopePluginContext — tag broadcastRequest (S2)', () => {
  it('namespaces the group and the broadcastRequest event, on the group and on .ref(key)', () => {
    const groupBroadcastRequest = vi.fn();
    const refBroadcastRequest = vi.fn();
    const ephemeral = vi.fn((group: string) => ({
      group,
      broadcastRequest: groupBroadcastRequest,
      ref: (key: string) => ({ key, broadcastRequest: refBroadcastRequest }),
    }));
    const scoped = scopePluginContext(ID, { tags: { ephemeral } });

    const handle = scoped.tags.ephemeral('team');
    expect(ephemeral).toHaveBeenCalledWith('__acme:feed::team');

    handle.broadcastRequest('confirm', { q: 1 });
    expect(groupBroadcastRequest).toHaveBeenCalledWith('__acme:feed::confirm', { q: 1 });

    handle.ref('eng').broadcastRequest('confirm', { q: 1 });
    expect(refBroadcastRequest).toHaveBeenCalledWith('__acme:feed::confirm', { q: 1 });
  });
});

describe('scopePluginContext — kv (A4)', () => {
  it('namespaces keys/prefix and strips the namespace off list() results', async () => {
    const get = vi.fn();
    const set = vi.fn();
    const del = vi.fn();
    const list = vi.fn(async () => ['__acme:feed::a', '__acme:feed::b', 'leaked-key']);
    const scoped = scopePluginContext(ID, { kv: { get, set, delete: del, list } });

    await scoped.kv.get('a');
    expect(get).toHaveBeenCalledWith('__acme:feed::a');
    await scoped.kv.set('a', 1);
    expect(set).toHaveBeenCalledWith('__acme:feed::a', 1);
    await scoped.kv.delete('a');

    expect(del).toHaveBeenCalledWith('__acme:feed::a');

    const result = await scoped.kv.list('pre');
    expect(list).toHaveBeenCalledWith('__acme:feed::pre');
    // Namespaced keys come back short; a foreign key (no prefix) is left as-is.
    expect(result).toEqual(['a', 'b', 'leaked-key']);

    await scoped.kv.list();
    expect(list).toHaveBeenLastCalledWith('__acme:feed::');
  });
});

describe('frameMatches — plugin intercept on its own event (S3)', () => {
  const compiled: any = {
    incoming: new Map([['__acme:feed::ping', { validator: undefined }]]),
    requests: new Map(),
    streams: new Map(),
    resumableStreams: new Map(),
    recordedStreams: new Map(),
    channels: new Map(),
    channelFamilies: new Map(),
  };

  function pluginFrame(event: string): InterceptFrame {
    return {
      event,
      payload: {},
      kind: 'incoming',
      routing: { channel: undefined } as any,
      owner: { kind: 'plugin', id: ID },
    } as InterceptFrame;
  }

  it('matches a bare key against the plugin-namespaced catalog without throwing', () => {
    expect(frameMatches(compiled, 'ping', pluginFrame('ping'))).toBe(true);
    expect(() => frameUnsafeCast(compiled, 'ping', pluginFrame('ping'))).not.toThrow();
  });

  it('still rejects a key the plugin never declared', () => {
    expect(() => frameMatches(compiled, 'nope', pluginFrame('nope'))).toThrow(
      /does not.*declare|declare/i,
    );
  });

  it('an app frame does not resolve against a plugin event', () => {
    const appFrame = {
      event: 'ping',
      payload: {},
      kind: 'incoming',
      routing: { channel: undefined } as any,
      owner: { kind: 'app' },
    } as InterceptFrame;
    expect(() => frameMatches(compiled, 'ping', appFrame)).toThrow();
  });
});
