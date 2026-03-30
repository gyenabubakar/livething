/* oxlint-disable @typescript-eslint/no-explicit-any -- testing utility tests */
import { Plugin } from '@/plugins/base.ts';
import { Channels } from '@/plugins/channels.ts';
import { Socket } from '@/socket/socket.ts';
import { inject, injectChannel } from '@/testing.ts';
import { describe, expect, it, vi } from 'vitest';
import type { FullSocketOptions } from '@/options.ts';
import type { PluginHelpers } from '@/plugins/base.ts';

interface TestContract {
  incoming: { notification: { id: string; title: string }; alert: { level: string } };
  outgoing: { ack: { id: string } };
  channels: {
    chat: {
      incoming: { message: { text: string; from: string } };
      outgoing: { 'send-message': { text: string } };
    };
  };
}

function createHelpers(): PluginHelpers {
  let counter = 0;
  return {
    rawSend: vi.fn(),
    generateId: (prefix?: string) => (prefix ? `${prefix}-${++counter}` : `${++counter}`),
    getState: () => 'open',
    getOptions: () => ({}),
    ensureConnected: vi.fn(),
    send: vi.fn(() => true),
    lazyAcquire: vi.fn(),
    lazyRelease: vi.fn(),
  };
}

function createSocket(plugins: Plugin[] = []) {
  const socket = new Socket<TestContract>(
    'ws://localhost',
    { pingInterval: 0 } as FullSocketOptions<TestContract>,
    plugins,
  );

  // If plugins are provided, wire up their helpers and install them
  for (const plugin of plugins) {
    plugin.helpers = createHelpers();
    plugin.install?.(socket as unknown as Record<string, unknown>);
  }

  return socket;
}

describe('inject()', () => {
  it('dispatches to on() handlers', () => {
    const socket = createSocket();
    const handler = vi.fn();

    socket.on('notification', handler);
    inject(socket, 'notification', { id: '1', title: 'Test' });

    expect(handler).toHaveBeenCalledWith({ id: '1', title: 'Test' });
  });

  it('works when socket is disconnected', () => {
    const socket = createSocket();
    expect(socket.getState()).toBe('closed');

    const handler = vi.fn();
    socket.on('notification', handler);
    inject(socket, 'notification', { id: '1', title: 'Test' });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('runs through middleware', () => {
    const socket = createSocket();
    socket.use((msg) => ({
      event: msg.event,
      payload: { ...(msg.payload as Record<string, unknown>), injected: true },
    }));

    const handler = vi.fn();
    socket.on('notification', handler);
    inject(socket, 'notification', { id: '1', title: 'Test' });

    expect(handler).toHaveBeenCalledWith({ id: '1', title: 'Test', injected: true });
  });

  it('middleware returning null drops the injected message', () => {
    const socket = createSocket();
    socket.use(() => null);

    const handler = vi.fn();
    socket.on('notification', handler);
    inject(socket, 'notification', { id: '1', title: 'Test' });

    expect(handler).not.toHaveBeenCalled();
  });

  it('runs through plugin onIncoming hooks', () => {
    class Tagger extends Plugin {
      id = 'tagger';
      override onIncoming(message: { event: string; payload: unknown }) {
        return {
          event: message.event,
          payload: { ...(message.payload as Record<string, unknown>), tagged: true },
        };
      }
    }

    const tagger = new Tagger();
    tagger.helpers = {} as PluginHelpers;
    const socket = createSocket([tagger]);

    const handler = vi.fn();
    socket.on('notification', handler);
    inject(socket, 'notification', { id: '1', title: 'Test' });

    expect(handler).toHaveBeenCalledWith({ id: '1', title: 'Test', tagged: true });
  });

  it('plugin onIncoming returning null drops the message', () => {
    class Dropper extends Plugin {
      id = 'dropper';
      override onIncoming() {
        return null;
      }
    }

    const dropper = new Dropper();
    dropper.helpers = {} as PluginHelpers;
    const socket = createSocket([dropper]);

    const handler = vi.fn();
    socket.on('notification', handler);
    inject(socket, 'notification', { id: '1', title: 'Test' });

    expect(handler).not.toHaveBeenCalled();
  });

  it('dispatches to the correct event handler only', () => {
    const socket = createSocket();
    const notifHandler = vi.fn();
    const alertHandler = vi.fn();

    socket.on('notification', notifHandler);
    socket.on('alert', alertHandler);
    inject(socket, 'notification', { id: '1', title: 'Test' });

    expect(notifHandler).toHaveBeenCalledTimes(1);
    expect(alertHandler).not.toHaveBeenCalled();
  });

  it('multiple inject calls dispatch independently', () => {
    const socket = createSocket();
    const handler = vi.fn();

    socket.on('notification', handler);
    inject(socket, 'notification', { id: '1', title: 'First' });
    inject(socket, 'notification', { id: '2', title: 'Second' });

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenNthCalledWith(1, { id: '1', title: 'First' });
    expect(handler).toHaveBeenNthCalledWith(2, { id: '2', title: 'Second' });
  });
});

describe('injectChannel()', () => {
  it('dispatches to channel on() handlers', () => {
    const channels = new Channels();
    const socket = createSocket([channels]);

    const handler = vi.fn();
    const ch = (socket as any).channel('chat');
    ch.on('message', handler);

    injectChannel(socket, 'chat', 'message', { text: 'hello', from: 'test' });

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'hello', from: 'test', _channel: 'chat' }),
    );
  });

  it('works when socket is disconnected', () => {
    const channels = new Channels();
    const socket = createSocket([channels]);
    expect(socket.getState()).toBe('closed');

    const handler = vi.fn();
    (socket as any).channel('chat').on('message', handler);

    injectChannel(socket, 'chat', 'message', { text: 'hi', from: 'test' });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('does not dispatch to other channels', () => {
    const channels = new Channels();
    const socket = createSocket([channels]);

    const chatHandler = vi.fn();
    (socket as any).channel('chat').on('message', chatHandler);

    // Inject into a non-existent channel — should not reach chat handler
    inject(socket, 'message' as any, { text: 'wrong', _channel: 'other' } as any);

    expect(chatHandler).not.toHaveBeenCalled();
  });

  it('runs through middleware before channel routing', () => {
    const channels = new Channels();
    const socket = createSocket([channels]);
    socket.use(() => null); // drop everything

    const handler = vi.fn();
    (socket as any).channel('chat').on('message', handler);

    injectChannel(socket, 'chat', 'message', { text: 'dropped', from: 'test' });

    expect(handler).not.toHaveBeenCalled();
  });
});
