import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { channels } from '~/primitives/channels/index.ts';
import { installMockWebSocket } from '~/test-helpers.ts';
import { inject, injectChannel } from '~/testing.ts';
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
}

function makeWithChannels() {
  return client<C>()(connect('wss://test'), channels());
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
