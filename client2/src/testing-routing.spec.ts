import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { channels } from '~/primitives/channels/index.ts';
import { namespaces } from '~/primitives/namespaces/index.ts';
import { installMockWebSocket } from '~/test-helpers.ts';
import { inject, injectChannel, injectNamespace } from '~/testing.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Socket } from '~/socket/api.ts';

interface C {
  incoming: { ping: { id: string } };
  channels: {
    general: {
      incoming: { message: { text: string } };
      outgoing: { send: { text: string } };
    };
    news: {
      incoming: { headline: { title: string } };
      outgoing: never;
    };
  };
  namespaces: {
    alerts: {
      incoming: { 'new-alert': { level: string }; dismissed: { id: string } };
      outgoing: { dismiss: { id: string } };
    };
  };
}

function makeWithChannels() {
  return client<C>()(connect('wss://test'), channels());
}

function makeWithNamespaces() {
  return client<C>()(connect('wss://test'), namespaces());
}

function makeWithBoth() {
  return client<C>()(connect('wss://test'), channels(), namespaces());
}

let restore: () => void;
beforeEach(() => {
  restore = installMockWebSocket();
});
afterEach(() => {
  restore();
});

describe('injectChannel — channels primitive routing while disconnected', () => {
  it('routes to channel on() handler via channels.onIncoming, no live socket needed', () => {
    const socket = makeWithChannels();
    const handler = vi.fn();
    socket.channel('general').on('message', handler);

    expect(socket.getState()).toBe('closed');
    injectChannel(socket as Socket<C>, 'general', 'message', { text: 'hello' });
    expect(handler).toHaveBeenCalledWith({ text: 'hello' });
  });

  it('does NOT fire a channel handler when the channel tag is absent (plain inject bypasses channel scoping)', () => {
    const socket = makeWithChannels();
    const channelHandler = vi.fn();
    socket.channel('general').on('message', channelHandler);

    // inject produces a frame with no __wskit.channel tag — channels.onIncoming
    // passes it through, so it reaches top-level dispatch, not channel handlers.
    inject(socket as Socket<C>, 'message' as keyof C['incoming'], {} as never);
    expect(channelHandler).not.toHaveBeenCalled();
  });

  it('does NOT fire the general channel handler when the tag targets a different channel', () => {
    const socket = makeWithChannels();
    const generalHandler = vi.fn();
    const newsHandler = vi.fn();
    socket.channel('general').on('message', generalHandler);
    socket.channel('news').on('headline', newsHandler);

    injectChannel(socket as Socket<C>, 'general', 'message', { text: 'only-general' });
    expect(generalHandler).toHaveBeenCalledWith({ text: 'only-general' });
    expect(newsHandler).not.toHaveBeenCalled();
  });

  it('routes multiple handlers on the same channel independently', () => {
    const socket = makeWithChannels();
    const handlerA = vi.fn();
    const handlerB = vi.fn();
    socket.channel('general').on('message', handlerA);
    socket.channel('general').on('message', handlerB);

    injectChannel(socket as Socket<C>, 'general', 'message', { text: 'both' });
    expect(handlerA).toHaveBeenCalledWith({ text: 'both' });
    expect(handlerB).toHaveBeenCalledWith({ text: 'both' });
  });
});

describe('injectNamespace — namespaces primitive routing while disconnected', () => {
  it('routes to namespace on() handler via namespaces.onIncoming, no live socket needed', () => {
    const socket = makeWithNamespaces();
    const handler = vi.fn();
    socket.namespace('alerts').on('new-alert', handler);

    expect(socket.getState()).toBe('closed');
    injectNamespace(socket as Socket<C>, 'alerts', 'new-alert', { level: 'critical' });
    expect(handler).toHaveBeenCalledWith({ level: 'critical' });
  });

  it('does NOT fire a namespace handler when the namespace tag is absent', () => {
    const socket = makeWithNamespaces();
    const nsHandler = vi.fn();
    socket.namespace('alerts').on('new-alert', nsHandler);

    // A plain inject has no __wskit.namespace — namespaces.onIncoming passes it
    // straight through without dispatching to namespace handlers.
    inject(socket as Socket<C>, 'new-alert' as keyof C['incoming'], {} as never);
    expect(nsHandler).not.toHaveBeenCalled();
  });

  it('does NOT fire the alerts handler when the tag targets a different namespace', () => {
    const socket = makeWithNamespaces();
    const alertsHandler = vi.fn();
    const otherHandler = vi.fn();
    socket.namespace('alerts').on('new-alert', alertsHandler);
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- 'other' is outside C['namespaces']; cast the unknown name to reach the runtime handler
    (socket.namespace('other' as any) as { on: (e: string, h: (p: unknown) => void) => void }).on(
      'new-alert',
      otherHandler,
    );

    injectNamespace(socket as Socket<C>, 'alerts', 'new-alert', { level: 'warn' });
    expect(alertsHandler).toHaveBeenCalledWith({ level: 'warn' });
    expect(otherHandler).not.toHaveBeenCalled();
  });

  it('routes multiple events in the same namespace independently', () => {
    const socket = makeWithNamespaces();
    const alertHandler = vi.fn();
    const dismissHandler = vi.fn();
    socket.namespace('alerts').on('new-alert', alertHandler);
    socket.namespace('alerts').on('dismissed', dismissHandler);

    injectNamespace(socket as Socket<C>, 'alerts', 'new-alert', { level: 'info' });
    expect(alertHandler).toHaveBeenCalledWith({ level: 'info' });
    expect(dismissHandler).not.toHaveBeenCalled();

    injectNamespace(socket as Socket<C>, 'alerts', 'dismissed', { id: '42' });
    expect(dismissHandler).toHaveBeenCalledWith({ id: '42' });
  });

  it('channel-tagged frames are not dispatched to namespace handlers', () => {
    const socket = makeWithBoth();
    const nsHandler = vi.fn();
    socket.namespace('alerts').on('new-alert', nsHandler);

    // A channel-scoped inject carries __wskit.channel, not __wskit.namespace, so
    // namespaces.onIncoming passes it through untouched.
    injectChannel(socket as Socket<C>, 'general', 'new-alert' as never, {} as never);
    expect(nsHandler).not.toHaveBeenCalled();
  });
});
