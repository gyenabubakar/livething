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
