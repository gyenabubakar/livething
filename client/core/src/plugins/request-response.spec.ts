import { RequestResponse } from '@/plugins/request-response.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('RequestResponse', () => {
  let rr: RequestResponse;
  let sendSpy: ReturnType<typeof vi.fn<(event: string, payload: unknown) => void>>;

  beforeEach(() => {
    vi.useFakeTimers();
    let counter = 0;
    rr = new RequestResponse({ timeout: 5_000 });
    rr.helpers = {
      rawSend: vi.fn(),
      generateId: (prefix?: string) => (prefix ? `${prefix}-${++counter}` : `${++counter}`),
      getState: () => 'open',
      getOptions: () => ({}),
      ensureConnected: vi.fn(),
    };
    sendSpy = vi.fn<(event: string, payload: unknown) => void>();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('tagRequest', () => {
    it('adds _correlationId to the payload', () => {
      const result = rr.tagRequest('get-balance', { userId: '1' }, 'req-1');
      expect(result).toEqual({ userId: '1', _correlationId: 'req-1' });
    });
  });

  describe('extractId', () => {
    it('returns _correlationId from payload', () => {
      expect(rr.extractId('response', { _correlationId: 'req-1', balance: 100 })).toBe('req-1');
    });

    it('returns null when _correlationId is missing', () => {
      expect(rr.extractId('event', { data: 'hi' })).toBeNull();
    });
  });

  describe('sendRequest', () => {
    it('sends a tagged message and resolves when response arrives', async () => {
      const promise = rr.sendRequest('get-balance', { userId: '1' }, sendSpy);

      expect(sendSpy).toHaveBeenCalledOnce();
      const [event, payload] = sendSpy.mock.calls[0]!;
      expect(event).toBe('get-balance');
      expect(payload).toHaveProperty('_correlationId');
      expect(payload).toHaveProperty('userId', '1');

      const correlationId = (payload as Record<string, unknown>)._correlationId as string;

      rr.onIncoming({
        event: 'get-balance',
        payload: { _correlationId: correlationId, balance: 42 },
      });

      const result = await promise;
      expect(result).toEqual({ _correlationId: correlationId, balance: 42 });
    });

    it('rejects on timeout', async () => {
      const promise = rr.sendRequest('slow', {}, sendSpy);

      vi.advanceTimersByTime(5_000);

      await expect(promise).rejects.toThrow('timed out');
    });

    it('uses per-call timeout override', async () => {
      const promise = rr.sendRequest('slow', {}, sendSpy, 1_000);

      vi.advanceTimersByTime(1_000);

      await expect(promise).rejects.toThrow('timed out');
    });

    it('resolves multiple concurrent requests independently', async () => {
      const p1 = rr.sendRequest('req1', {}, sendSpy);
      const p2 = rr.sendRequest('req2', {}, sendSpy);

      const id1 = (sendSpy.mock.calls[0]![1] as Record<string, unknown>)._correlationId as string;
      const id2 = (sendSpy.mock.calls[1]![1] as Record<string, unknown>)._correlationId as string;

      rr.onIncoming({ event: 'req2', payload: { _correlationId: id2, result: 'two' } });
      rr.onIncoming({ event: 'req1', payload: { _correlationId: id1, result: 'one' } });

      expect(await p1).toHaveProperty('result', 'one');
      expect(await p2).toHaveProperty('result', 'two');
    });
  });

  describe('onIncoming', () => {
    it('passes through messages without a correlationId', () => {
      const msg = { event: 'notification', payload: { text: 'hi' } };
      expect(rr.onIncoming(msg)).toEqual(msg);
    });

    it('passes through responses with no matching pending request', () => {
      const msg = { event: 'resp', payload: { _correlationId: 'unknown' } };
      expect(rr.onIncoming(msg)).toEqual(msg);
    });

    it('consumes matched responses (returns null)', async () => {
      const promise = rr.sendRequest('test', {}, sendSpy);
      const id = (sendSpy.mock.calls[0]![1] as Record<string, unknown>)._correlationId as string;

      const result = rr.onIncoming({ event: 'test', payload: { _correlationId: id, data: 1 } });
      expect(result).toBeNull();

      await promise;
    });
  });

  describe('onClose', () => {
    it('rejects all pending requests with DisconnectedError', async () => {
      const p1 = rr.sendRequest('req1', {}, sendSpy);
      const p2 = rr.sendRequest('req2', {}, sendSpy);

      rr.onClose?.(1000, 'normal');

      await expect(p1).rejects.toThrow('Disconnected');
      await expect(p2).rejects.toThrow('Disconnected');
    });
  });

  describe('defaults', () => {
    it('uses 10s default timeout', async () => {
      let c = 0;
      const defaultRr = new RequestResponse();
      defaultRr.helpers = {
        rawSend: vi.fn(),
        generateId: (p?: string) => (p ? `${p}-${++c}` : `${++c}`),
        getState: () => 'open',
        getOptions: () => ({}),
        ensureConnected: vi.fn(),
      };
      const promise = defaultRr.sendRequest('test', {}, sendSpy);

      vi.advanceTimersByTime(10_000);

      await expect(promise).rejects.toThrow('timed out');
    });
  });

  describe('edge cases', () => {
    it('ignores responses that arrive after timeout', async () => {
      const promise = rr.sendRequest('slow', {}, sendSpy);
      const id = (sendSpy.mock.calls[0]![1] as Record<string, unknown>)._correlationId as string;

      vi.advanceTimersByTime(5_000);
      await expect(promise).rejects.toThrow('timed out');

      const result = rr.onIncoming({ event: 'slow', payload: { _correlationId: id, late: true } });
      expect(result).toEqual({ event: 'slow', payload: { _correlationId: id, late: true } });
    });

    it('calling onClose multiple times is safe', async () => {
      const p = rr.sendRequest('test', {}, sendSpy);
      rr.onClose?.(1000, 'normal');
      expect(() => rr.onClose?.(1000, 'normal')).not.toThrow();
      await expect(p).rejects.toThrow('Disconnected');
    });
  });
});
