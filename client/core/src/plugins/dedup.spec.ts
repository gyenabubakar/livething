import { Dedup } from '@/plugins/dedup.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('Dedup', () => {
  let dedup: Dedup;

  beforeEach(() => {
    dedup = new Dedup({ windowMs: 1_000 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes through messages without an ID', () => {
    const msg = { event: 'test', payload: { data: 'hello' } };
    expect(dedup.onIncoming(msg)).toEqual(msg);
  });

  it('passes through a message with a new ID', () => {
    const msg = { event: 'test', payload: { _messageId: 'abc', data: 1 } };
    expect(dedup.onIncoming(msg)).toEqual(msg);
  });

  it('drops a duplicate message with the same ID', () => {
    const msg = { event: 'test', payload: { _messageId: 'abc', data: 1 } };
    dedup.onIncoming(msg);
    expect(dedup.onIncoming(msg)).toBeNull();
  });

  it('allows the same ID after the window expires', () => {
    vi.useFakeTimers();
    const msg = { event: 'test', payload: { _messageId: 'abc', data: 1 } };

    dedup.onIncoming(msg);
    expect(dedup.onIncoming(msg)).toBeNull();

    vi.advanceTimersByTime(1_500);

    expect(dedup.onIncoming(msg)).toEqual(msg);
    vi.useRealTimers();
  });

  it('tracks multiple IDs independently', () => {
    const msg1 = { event: 'test', payload: { _messageId: 'a' } };
    const msg2 = { event: 'test', payload: { _messageId: 'b' } };

    expect(dedup.onIncoming(msg1)).toEqual(msg1);
    expect(dedup.onIncoming(msg2)).toEqual(msg2);
    expect(dedup.onIncoming(msg1)).toBeNull();
    expect(dedup.onIncoming(msg2)).toBeNull();
  });

  it('uses default 60s window when no options are provided', () => {
    const defaultDedup = new Dedup();
    vi.useFakeTimers();

    const msg = { event: 'test', payload: { _messageId: 'x' } };
    defaultDedup.onIncoming(msg);

    vi.advanceTimersByTime(59_000);
    expect(defaultDedup.onIncoming(msg)).toBeNull();

    vi.advanceTimersByTime(2_000);
    expect(defaultDedup.onIncoming(msg)).toEqual(msg);

    vi.useRealTimers();
  });

  it('returns null for extractId when _messageId is missing', () => {
    expect(dedup.extractId('test', { foo: 'bar' })).toBeNull();
  });

  it('returns the ID for extractId when _messageId is present', () => {
    expect(dedup.extractId('test', { _messageId: 'abc' })).toBe('abc');
  });

  it('treats non-string _messageId as missing (passes through)', () => {
    const msg = { event: 'test', payload: { _messageId: 42 } };
    expect(dedup.onIncoming(msg)).toEqual(msg);
    expect(dedup.onIncoming(msg)).toEqual(msg);
  });

  it('handles non-object payloads gracefully', () => {
    const msg = { event: 'test', payload: 'just a string' };
    expect(dedup.onIncoming(msg)).toEqual(msg);
  });
});
