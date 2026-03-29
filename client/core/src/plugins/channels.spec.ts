import { describe, expect, it, vi } from 'vitest';
import { Channels } from '@/plugins/channels.ts';

describe('Channels', () => {
  describe('extractChannel', () => {
    it('returns _channel from payload', () => {
      const channels = new Channels();
      expect(channels.extractChannel('msg', { _channel: 'chat' })).toBe('chat');
    });

    it('returns null when _channel is missing', () => {
      const channels = new Channels();
      expect(channels.extractChannel('msg', { text: 'hi' })).toBeNull();
    });

    it('returns null when _channel is not a string', () => {
      const channels = new Channels();
      expect(channels.extractChannel('msg', { _channel: 42 })).toBeNull();
    });
  });

  describe('tagChannel', () => {
    it('adds _channel to the payload', () => {
      const channels = new Channels();
      const result = channels.tagChannel('msg', { text: 'hi' }, 'chat');
      expect(result).toEqual({ text: 'hi', _channel: 'chat' });
    });

    it('overwrites existing _channel', () => {
      const channels = new Channels();
      const result = channels.tagChannel('msg', { _channel: 'old' }, 'new');
      expect(result).toEqual({ _channel: 'new' });
    });
  });

  describe('onIncoming routing', () => {
    it('passes through messages without a channel', () => {
      const channels = new Channels();
      const msg = { event: 'global', payload: { text: 'hi' } };
      expect(channels.onIncoming(msg)).toEqual(msg);
    });

    it('passes through channel messages with no registered handlers', () => {
      const channels = new Channels();
      const msg = { event: 'message', payload: { _channel: 'chat', text: 'hi' } };
      expect(channels.onIncoming(msg)).toEqual(msg);
    });

    it('dispatches to registered channel handler and consumes the message', () => {
      const channels = new Channels();
      const handler = vi.fn();
      channels.registerHandler('chat', 'message', handler);

      const msg = { event: 'message', payload: { _channel: 'chat', text: 'hi' } };
      const result = channels.onIncoming(msg);

      expect(handler).toHaveBeenCalledWith(msg.payload);
      expect(result).toBeNull();
    });

    it('does not dispatch to handlers on a different channel', () => {
      const channels = new Channels();
      const chatHandler = vi.fn();
      const alertHandler = vi.fn();
      channels.registerHandler('chat', 'message', chatHandler);
      channels.registerHandler('alerts', 'message', alertHandler);

      const msg = { event: 'message', payload: { _channel: 'chat', text: 'hi' } };
      channels.onIncoming(msg);

      expect(chatHandler).toHaveBeenCalledOnce();
      expect(alertHandler).not.toHaveBeenCalled();
    });

    it('does not dispatch to handlers for a different event', () => {
      const channels = new Channels();
      const messageHandler = vi.fn();
      const typingHandler = vi.fn();
      channels.registerHandler('chat', 'message', messageHandler);
      channels.registerHandler('chat', 'typing', typingHandler);

      const msg = { event: 'message', payload: { _channel: 'chat', text: 'hi' } };
      channels.onIncoming(msg);

      expect(messageHandler).toHaveBeenCalledOnce();
      expect(typingHandler).not.toHaveBeenCalled();
    });

    it('dispatches to multiple handlers for the same channel+event', () => {
      const channels = new Channels();
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      channels.registerHandler('chat', 'message', handler1);
      channels.registerHandler('chat', 'message', handler2);

      const msg = { event: 'message', payload: { _channel: 'chat', text: 'hi' } };
      channels.onIncoming(msg);

      expect(handler1).toHaveBeenCalledOnce();
      expect(handler2).toHaveBeenCalledOnce();
    });
  });

  describe('registerHandler', () => {
    it('returns an unsubscribe function', () => {
      const channels = new Channels();
      const handler = vi.fn();
      const unsub = channels.registerHandler('chat', 'message', handler);

      unsub();

      const msg = { event: 'message', payload: { _channel: 'chat', text: 'hi' } };
      channels.onIncoming(msg);

      expect(handler).not.toHaveBeenCalled();
    });

    it('cleans up empty maps after unsubscribe', () => {
      const channels = new Channels();
      const handler = vi.fn();
      const unsub = channels.registerHandler('chat', 'message', handler);

      unsub();

      // After unsubscribe, channel messages pass through since no handlers remain
      const msg = { event: 'message', payload: { _channel: 'chat', text: 'hi' } };
      expect(channels.onIncoming(msg)).toEqual(msg);
    });
  });

  describe('options', () => {
    it('stores ttl option', () => {
      const channels = new Channels({ ttl: 5_000 });
      expect(channels.ttl).toBe(5_000);
    });

    it('stores per-event ttl option', () => {
      const ttl = { typing: 3_000, 'cursor-move': 1_000 };
      const channels = new Channels({ ttl });
      expect(channels.ttl).toEqual(ttl);
    });

    it('defaults ttl to undefined', () => {
      const channels = new Channels();
      expect(channels.ttl).toBeUndefined();
    });
  });
});
