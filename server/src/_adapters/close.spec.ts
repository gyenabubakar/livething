import { describe, expect, it } from 'vitest';
import { normalizeCloseReason } from './close.ts';

describe('normalizeCloseReason', () => {
  it('leaves a reason within the WebSocket limit unchanged', () => {
    expect(normalizeCloseReason('connection closed')).toBe('connection closed');
  });

  it('truncates by UTF-8 bytes without splitting a character', () => {
    const reason = normalizeCloseReason('🙂'.repeat(100));

    expect(reason).toBe('🙂'.repeat(30));
    expect(new TextEncoder().encode(reason).byteLength).toBe(120);
  });

  it('preserves an omitted reason', () => {
    expect(normalizeCloseReason()).toBeUndefined();
  });
});
