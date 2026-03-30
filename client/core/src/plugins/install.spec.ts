/* oxlint-disable @typescript-eslint/no-explicit-any -- testing install with raw socket objects */
import { Ack } from '@/plugins/ack.ts';
import { Channels } from '@/plugins/channels.ts';
import { RequestResponse } from '@/plugins/request-response.ts';
import { Stream } from '@/plugins/stream.ts';
import { describe, expect, it, vi } from 'vitest';
import type { Plugin, PluginHelpers } from '@/plugins/base.ts';

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

function createFakeSocket(): Record<string, unknown> {
  return {
    send: Object.assign((_event: string, _payload: unknown) => true, {}),
  };
}

/** Simulate what createSocket does: set helpers, then call install. */
function installPlugin(
  plugin: Plugin<any, any>,
  socket: Record<string, unknown>,
  helpers: PluginHelpers,
) {
  plugin.helpers = helpers;
  plugin.install?.(socket);
}

describe('Plugin.install', () => {
  describe('Ack', () => {
    it('attaches send.withAck to the socket', () => {
      const socket = createFakeSocket();
      const ack = new Ack();

      installPlugin(ack, socket, createHelpers());

      expect(typeof (socket.send as any).withAck).toBe('function');
    });

    it('send.withAck delegates to sendWithAck', () => {
      vi.useFakeTimers();
      const socket = createFakeSocket();
      const helpers = createHelpers();
      const ack = new Ack({ timeout: 5_000 });

      installPlugin(ack, socket, helpers);

      const promise = (socket.send as any).withAck('test', { data: 1 });
      expect(helpers.rawSend).toHaveBeenCalledOnce();

      const [_event, payload] = (helpers.rawSend as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(payload).toHaveProperty('_ackId');

      const ackId = (payload as Record<string, unknown>)._ackId as string;
      ack.onIncoming({ event: '_ack', payload: { id: ackId } });

      vi.useRealTimers();
      return expect(promise).resolves.toBeUndefined();
    });

    it('socket.send remains callable as a function after install', () => {
      const socket = createFakeSocket();
      const ack = new Ack();

      installPlugin(ack, socket, createHelpers());

      expect(typeof socket.send).toBe('function');
      expect((socket.send as any)('event', {})).toBe(true);
    });
  });

  describe('RequestResponse', () => {
    it('attaches request to the socket', () => {
      const socket = createFakeSocket();
      const rr = new RequestResponse();

      installPlugin(rr, socket, createHelpers());

      expect(typeof socket.request).toBe('function');
    });

    it('request delegates to sendRequest', () => {
      vi.useFakeTimers();
      const socket = createFakeSocket();
      const helpers = createHelpers();
      const rr = new RequestResponse({ timeout: 5_000 });

      installPlugin(rr, socket, helpers);

      const promise = (socket.request as any)('get-balance', { userId: '1' });
      expect(helpers.rawSend).toHaveBeenCalledOnce();

      const [_event, payload] = (helpers.rawSend as ReturnType<typeof vi.fn>).mock.calls[0]!;
      const correlationId = (payload as Record<string, unknown>)._correlationId as string;
      rr.onIncoming({
        event: 'get-balance',
        payload: { _correlationId: correlationId, balance: 42 },
      });

      vi.useRealTimers();
      return expect(promise).resolves.toHaveProperty('balance', 42);
    });
  });

  describe('Channels', () => {
    it('attaches channel to the socket', () => {
      const socket = createFakeSocket();
      const channels = new Channels();

      installPlugin(channels, socket, createHelpers());

      expect(typeof socket.channel).toBe('function');
    });

    it('channel() returns an object with on and send', () => {
      const socket = createFakeSocket();
      const channels = new Channels();

      installPlugin(channels, socket, createHelpers());

      const ch = (socket.channel as any)('chat') as Record<string, unknown>;
      expect(typeof ch.on).toBe('function');
      expect(typeof ch.send).toBe('function');
    });

    it('channel().on routes through registerHandler', () => {
      const socket = createFakeSocket();
      const channels = new Channels();

      installPlugin(channels, socket, createHelpers());

      const handler = vi.fn();
      const ch = (socket.channel as any)('chat') as Record<string, any>;
      ch.on('message', handler);

      channels.onIncoming({ event: 'message', payload: { _channel: 'chat', text: 'hi' } });
      expect(handler).toHaveBeenCalledWith({ _channel: 'chat', text: 'hi' });
    });

    it('channel().send tags and sends via helpers.send', () => {
      const socket = createFakeSocket();
      const helpers = createHelpers();
      const channels = new Channels();

      installPlugin(channels, socket, helpers);

      const ch = (socket.channel as any)('chat') as Record<string, any>;
      ch.send('send-message', { text: 'hello' });

      expect(helpers.send).toHaveBeenCalledWith(
        'send-message',
        {
          text: 'hello',
          _channel: 'chat',
        },
        undefined,
      );
    });
  });

  describe('Stream', () => {
    it('attaches onStream to the socket', () => {
      const socket = createFakeSocket();
      const stream = new Stream();

      installPlugin(stream, socket, createHelpers());

      expect(typeof socket.onStream).toBe('function');
    });

    it('onStream delegates to registerStream', () => {
      const socket = createFakeSocket();
      const stream = new Stream({ timeout: 5_000 });

      installPlugin(stream, socket, createHelpers());

      const onChunk = vi.fn();
      (socket.onStream as any)('ai-response', { onChunk });

      stream.onIncoming({ event: 'ai-response', payload: { _streamId: 's1', text: 'hi' } });
      expect(onChunk).toHaveBeenCalledWith({ _streamId: 's1', text: 'hi' }, 's1');
    });
  });

  describe('lazy consumer tracking', () => {
    it('request() calls lazyAcquire', () => {
      vi.useFakeTimers();
      const socket = createFakeSocket();
      const helpers = createHelpers();
      const rr = new RequestResponse({ timeout: 5_000 });

      installPlugin(rr, socket, helpers);
      (socket.request as any)('get-balance', {});

      expect(helpers.lazyAcquire).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    });

    it('send.withAck() calls lazyAcquire', () => {
      vi.useFakeTimers();
      const socket = createFakeSocket();
      const helpers = createHelpers();
      const ack = new Ack({ timeout: 5_000 });

      installPlugin(ack, socket, helpers);
      (socket.send as any).withAck('test', {});

      expect(helpers.lazyAcquire).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    });

    it('channel().on() calls lazyAcquire', () => {
      const socket = createFakeSocket();
      const helpers = createHelpers();
      const channels = new Channels();

      installPlugin(channels, socket, helpers);

      const ch = (socket.channel as any)('chat') as Record<string, any>;
      ch.on('message', vi.fn());

      expect(helpers.lazyAcquire).toHaveBeenCalledTimes(1);
    });

    it('channel().on() unsubscribe calls lazyRelease', () => {
      const socket = createFakeSocket();
      const helpers = createHelpers();
      const channels = new Channels();

      installPlugin(channels, socket, helpers);

      const ch = (socket.channel as any)('chat') as Record<string, any>;
      const unsub = ch.on('message', vi.fn());
      unsub();

      expect(helpers.lazyRelease).toHaveBeenCalledTimes(1);
    });

    it('onStream() calls ensureConnected', () => {
      const socket = createFakeSocket();
      const helpers = createHelpers();
      const stream = new Stream();

      installPlugin(stream, socket, helpers);
      (socket.onStream as any)('ai-response', { onChunk: vi.fn() });

      expect(helpers.ensureConnected).toHaveBeenCalledTimes(1);
    });
  });

  describe('Plugins without install', () => {
    it('Dedup has no install (hooks only)', async () => {
      const { Dedup } = await import('@/plugins/dedup.ts');
      const dedup = new Dedup();
      expect(dedup.install).toBeUndefined();
    });

    it('Replay has no install (hooks only)', async () => {
      const { Replay } = await import('@/plugins/replay.ts');
      const replay = new Replay();
      expect(replay.install).toBeUndefined();
    });
  });
});
