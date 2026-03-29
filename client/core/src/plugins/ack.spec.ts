import { Ack } from '@/plugins/ack.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('Ack', () => {
  let ack: Ack;
  let sendSpy: ReturnType<typeof vi.fn<(event: string, payload: unknown) => void>>;

  beforeEach(() => {
    vi.useFakeTimers();
    ack = new Ack({ timeout: 5_000 });
    sendSpy = vi.fn<(event: string, payload: unknown) => void>();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('tagMessage', () => {
    it('adds _ackId to the payload', () => {
      const result = ack.tagMessage('chat', { text: 'hi' }, 'ack-1');
      expect(result).toEqual({ text: 'hi', _ackId: 'ack-1' });
    });
  });

  describe('extractId', () => {
    it('returns id from _ack event', () => {
      expect(ack.extractId('_ack', { id: 'ack-1' })).toBe('ack-1');
    });

    it('returns null for non-ack events', () => {
      expect(ack.extractId('message', { id: 'ack-1' })).toBeNull();
    });

    it('returns null when id is missing', () => {
      expect(ack.extractId('_ack', { data: 'hi' })).toBeNull();
    });
  });

  describe('sendWithAck', () => {
    it('sends a tagged message and resolves when ack arrives', async () => {
      const promise = ack.sendWithAck('chat-message', { text: 'hi' }, sendSpy);

      expect(sendSpy).toHaveBeenCalledOnce();
      const payload = sendSpy.mock.calls[0]![1] as Record<string, unknown>;
      expect(payload).toHaveProperty('_ackId');
      expect(payload).toHaveProperty('text', 'hi');

      const ackId = payload._ackId as string;
      ack.onIncoming({ event: '_ack', payload: { id: ackId } });

      await expect(promise).resolves.toBeUndefined();
    });

    it('rejects on timeout', async () => {
      const promise = ack.sendWithAck('msg', {}, sendSpy);

      vi.advanceTimersByTime(5_000);

      await expect(promise).rejects.toThrow('timed out');
    });

    it('uses per-call timeout override', async () => {
      const promise = ack.sendWithAck('msg', {}, sendSpy, 1_000);

      vi.advanceTimersByTime(1_000);

      await expect(promise).rejects.toThrow('timed out');
    });

    it('resolves multiple concurrent acks independently', async () => {
      const p1 = ack.sendWithAck('msg1', {}, sendSpy);
      const p2 = ack.sendWithAck('msg2', {}, sendSpy);

      const id1 = (sendSpy.mock.calls[0]![1] as Record<string, unknown>)._ackId as string;
      const id2 = (sendSpy.mock.calls[1]![1] as Record<string, unknown>)._ackId as string;

      ack.onIncoming({ event: '_ack', payload: { id: id2 } });
      ack.onIncoming({ event: '_ack', payload: { id: id1 } });

      await expect(p1).resolves.toBeUndefined();
      await expect(p2).resolves.toBeUndefined();
    });
  });

  describe('onIncoming', () => {
    it('passes through non-ack messages', () => {
      const msg = { event: 'notification', payload: { text: 'hi' } };
      expect(ack.onIncoming(msg)).toEqual(msg);
    });

    it('passes through ack messages with no matching pending', () => {
      const msg = { event: '_ack', payload: { id: 'unknown' } };
      expect(ack.onIncoming(msg)).toEqual(msg);
    });

    it('consumes matched ack messages (returns null)', async () => {
      const promise = ack.sendWithAck('test', {}, sendSpy);
      const ackId = (sendSpy.mock.calls[0]![1] as Record<string, unknown>)._ackId as string;

      const result = ack.onIncoming({ event: '_ack', payload: { id: ackId } });
      expect(result).toBeNull();

      await promise;
    });
  });

  describe('onClose', () => {
    it('rejects all pending acks with Disconnected error', async () => {
      const p1 = ack.sendWithAck('msg1', {}, sendSpy);
      const p2 = ack.sendWithAck('msg2', {}, sendSpy);

      ack.onClose?.(1000, 'normal');

      await expect(p1).rejects.toThrow('Disconnected');
      await expect(p2).rejects.toThrow('Disconnected');
    });
  });

  describe('defaults', () => {
    it('uses 10s default timeout', async () => {
      const defaultAck = new Ack();
      const promise = defaultAck.sendWithAck('test', {}, sendSpy);

      vi.advanceTimersByTime(10_000);

      await expect(promise).rejects.toThrow('timed out');
    });
  });

  describe('edge cases', () => {
    it('ignores acks that arrive after timeout', async () => {
      const promise = ack.sendWithAck('msg', {}, sendSpy);
      const ackId = (sendSpy.mock.calls[0]![1] as Record<string, unknown>)._ackId as string;

      vi.advanceTimersByTime(5_000);
      await expect(promise).rejects.toThrow('timed out');

      const result = ack.onIncoming({ event: '_ack', payload: { id: ackId } });
      expect(result).toEqual({ event: '_ack', payload: { id: ackId } });
    });

    it('calling onClose multiple times is safe', async () => {
      const p = ack.sendWithAck('test', {}, sendSpy);
      ack.onClose?.(1000, 'normal');
      expect(() => ack.onClose?.(1000, 'normal')).not.toThrow();
      await expect(p).rejects.toThrow('Disconnected');
    });
  });
});
