import { Stream } from '@/plugins/stream.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('Stream', () => {
  let stream: Stream;

  beforeEach(() => {
    vi.useFakeTimers();
    stream = new Stream({ timeout: 5_000 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('extractStreamId', () => {
    it('returns _streamId from payload', () => {
      expect(stream.extractStreamId('msg', { _streamId: 'abc' })).toBe('abc');
    });

    it('returns null when _streamId is missing', () => {
      expect(stream.extractStreamId('msg', { text: 'hi' })).toBeNull();
    });
  });

  describe('isStreamEnd', () => {
    it('returns true when _streamEnd is true', () => {
      expect(stream.isStreamEnd('msg', { _streamEnd: true })).toBe(true);
    });

    it('returns false when _streamEnd is missing or false', () => {
      expect(stream.isStreamEnd('msg', {})).toBe(false);
      expect(stream.isStreamEnd('msg', { _streamEnd: false })).toBe(false);
    });
  });

  describe('onIncoming', () => {
    it('passes through messages without _streamId', () => {
      const msg = { event: 'test', payload: { text: 'hi' } };
      expect(stream.onIncoming(msg)).toEqual(msg);
    });

    it('passes through stream messages with no registered handlers', () => {
      const msg = { event: 'ai-response', payload: { _streamId: 'abc', text: 'hi' } };
      expect(stream.onIncoming(msg)).toEqual(msg);
    });

    it('does NOT consume stream messages (returns the message)', () => {
      const onChunk = vi.fn();
      stream.registerStream('ai-response', { onChunk });

      const msg = { event: 'ai-response', payload: { _streamId: 'abc', text: 'hi' } };
      const result = stream.onIncoming(msg);

      expect(result).toEqual(msg);
      expect(onChunk).toHaveBeenCalledWith(msg.payload, 'abc');
    });

    it('calls onChunk for each chunk', () => {
      const onChunk = vi.fn();
      stream.registerStream('ai-response', { onChunk });

      stream.onIncoming({ event: 'ai-response', payload: { _streamId: 's1', text: 'a' } });
      stream.onIncoming({ event: 'ai-response', payload: { _streamId: 's1', text: 'b' } });
      stream.onIncoming({ event: 'ai-response', payload: { _streamId: 's1', text: 'c' } });

      expect(onChunk).toHaveBeenCalledTimes(3);
      expect(onChunk.mock.calls[0]![1]).toBe('s1');
    });

    it('calls onEnd when stream completes', () => {
      const onChunk = vi.fn();
      const onEnd = vi.fn();
      stream.registerStream('ai-response', { onChunk, onEnd });

      stream.onIncoming({ event: 'ai-response', payload: { _streamId: 's1', text: 'a' } });
      stream.onIncoming({
        event: 'ai-response',
        payload: { _streamId: 's1', text: 'done', _streamEnd: true },
      });

      expect(onChunk).toHaveBeenCalledTimes(2);
      expect(onEnd).toHaveBeenCalledWith('s1');
    });

    it('calls onTimeout when stream does not complete within timeout', () => {
      const onChunk = vi.fn();
      const onTimeout = vi.fn();
      stream.registerStream('ai-response', { onChunk, onTimeout });

      stream.onIncoming({ event: 'ai-response', payload: { _streamId: 's1', text: 'a' } });

      vi.advanceTimersByTime(5_000);

      expect(onTimeout).toHaveBeenCalledWith('s1');
    });

    it('does not call onTimeout after stream completes', () => {
      const onTimeout = vi.fn();
      stream.registerStream('ai-response', { onChunk: vi.fn(), onTimeout });

      stream.onIncoming({ event: 'ai-response', payload: { _streamId: 's1', text: 'a' } });
      stream.onIncoming({
        event: 'ai-response',
        payload: { _streamId: 's1', _streamEnd: true },
      });

      vi.advanceTimersByTime(10_000);

      expect(onTimeout).not.toHaveBeenCalled();
    });

    it('tracks multiple streams independently', () => {
      const onChunk = vi.fn();
      const onEnd = vi.fn();
      stream.registerStream('ai-response', { onChunk, onEnd });

      stream.onIncoming({ event: 'ai-response', payload: { _streamId: 's1', text: 'a' } });
      stream.onIncoming({ event: 'ai-response', payload: { _streamId: 's2', text: 'x' } });
      stream.onIncoming({
        event: 'ai-response',
        payload: { _streamId: 's1', _streamEnd: true },
      });

      expect(onChunk).toHaveBeenCalledTimes(3);
      expect(onEnd).toHaveBeenCalledWith('s1');
      expect(onEnd).not.toHaveBeenCalledWith('s2');
    });
  });

  describe('registerStream', () => {
    it('returns an unsubscribe function', () => {
      const onChunk = vi.fn();
      const unsub = stream.registerStream('ai-response', { onChunk });
      unsub();

      stream.onIncoming({ event: 'ai-response', payload: { _streamId: 's1', text: 'a' } });
      expect(onChunk).not.toHaveBeenCalled();
    });
  });

  describe('onClose', () => {
    it('calls onTimeout for all active streams', () => {
      const onTimeout = vi.fn();
      stream.registerStream('ai-response', { onChunk: vi.fn(), onTimeout });

      stream.onIncoming({ event: 'ai-response', payload: { _streamId: 's1', text: 'a' } });

      stream.onClose?.(1000, 'normal');

      expect(onTimeout).toHaveBeenCalledWith('s1');
    });
  });

  describe('defaults', () => {
    it('uses 30s default timeout', () => {
      const defaultStream = new Stream();
      const onTimeout = vi.fn();
      defaultStream.registerStream('ai-response', { onChunk: vi.fn(), onTimeout });

      defaultStream.onIncoming({
        event: 'ai-response',
        payload: { _streamId: 's1', text: 'a' },
      });

      vi.advanceTimersByTime(29_000);
      expect(onTimeout).not.toHaveBeenCalled();

      vi.advanceTimersByTime(2_000);
      expect(onTimeout).toHaveBeenCalledWith('s1');
    });
  });

  describe('edge cases', () => {
    it('only ends stream when _streamEnd is exactly true', () => {
      const onEnd = vi.fn();
      stream.registerStream('ai-response', { onChunk: vi.fn(), onEnd });

      stream.onIncoming({ event: 'ai-response', payload: { _streamId: 's1', _streamEnd: 1 } });
      expect(onEnd).not.toHaveBeenCalled();

      stream.onIncoming({
        event: 'ai-response',
        payload: { _streamId: 's1', _streamEnd: true },
      });
      expect(onEnd).toHaveBeenCalledWith('s1');
    });

    it('calling unsubscribe twice is safe', () => {
      const unsub = stream.registerStream('ai-response', { onChunk: vi.fn() });
      unsub();
      expect(() => unsub()).not.toThrow();
    });

    it('new chunks after stream end start a fresh stream', () => {
      const onChunk = vi.fn();
      const onEnd = vi.fn();
      stream.registerStream('ai-response', { onChunk, onEnd });

      stream.onIncoming({
        event: 'ai-response',
        payload: { _streamId: 's1', text: 'a', _streamEnd: true },
      });
      expect(onEnd).toHaveBeenCalledTimes(1);

      stream.onIncoming({ event: 'ai-response', payload: { _streamId: 's1', text: 'b' } });
      expect(onChunk).toHaveBeenCalledTimes(2);
    });
  });

  describe('edge cases — lifecycle', () => {
    it('unsubscribe during active stream cleans up timeout timer', () => {
      const onChunk = vi.fn();
      const onTimeout = vi.fn();
      const unsub = stream.registerStream('ai-response', { onChunk, onTimeout });

      stream.onIncoming({ event: 'ai-response', payload: { _streamId: 's1', text: 'a' } });
      expect(onChunk).toHaveBeenCalledTimes(1);

      unsub();

      vi.advanceTimersByTime(10_000);
      expect(onTimeout).not.toHaveBeenCalled();

      stream.onIncoming({ event: 'ai-response', payload: { _streamId: 's1', text: 'b' } });
      expect(onChunk).toHaveBeenCalledTimes(1);
    });

    it('multiple handlers for same stream event', () => {
      const onChunk1 = vi.fn();
      const onEnd1 = vi.fn();
      const onChunk2 = vi.fn();
      const onEnd2 = vi.fn();

      stream.registerStream('ai-response', { onChunk: onChunk1, onEnd: onEnd1 });
      stream.registerStream('ai-response', { onChunk: onChunk2, onEnd: onEnd2 });

      stream.onIncoming({ event: 'ai-response', payload: { _streamId: 's1', text: 'a' } });
      stream.onIncoming({ event: 'ai-response', payload: { _streamId: 's1', text: 'b' } });

      expect(onChunk1).toHaveBeenCalledTimes(2);
      expect(onChunk2).toHaveBeenCalledTimes(2);

      stream.onIncoming({
        event: 'ai-response',
        payload: { _streamId: 's1', _streamEnd: true },
      });

      expect(onEnd1).toHaveBeenCalledWith('s1');
      expect(onEnd2).toHaveBeenCalledWith('s1');
    });

    it('chunks arriving after timeout fired start a fresh stream', () => {
      const onChunk = vi.fn();
      const onTimeout = vi.fn();
      stream.registerStream('ai-response', { onChunk, onTimeout });

      stream.onIncoming({ event: 'ai-response', payload: { _streamId: 's1', text: 'a' } });
      expect(onChunk).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(5_000);
      expect(onTimeout).toHaveBeenCalledWith('s1');

      stream.onIncoming({ event: 'ai-response', payload: { _streamId: 's1', text: 'b' } });
      expect(onChunk).toHaveBeenCalledTimes(2);

      vi.advanceTimersByTime(4_000);
      expect(onTimeout).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(2_000);
      expect(onTimeout).toHaveBeenCalledTimes(2);
    });
  });
});
