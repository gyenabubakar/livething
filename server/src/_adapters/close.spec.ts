import { describe, expect, it, vi } from 'vitest';
import { normalizeCloseReason, normalizeConnectionDescriptor } from './close.ts';

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

  it('keeps custom descriptor methods bound to their original instance', () => {
    class Descriptor {
      #sent = 0;
      readonly userId = 'user-1';
      readonly close = vi.fn();

      send(): void {
        this.#sent += 1;
      }

      bufferedAmount(): number {
        return this.#sent;
      }
    }

    const original = new Descriptor();
    const descriptor = normalizeConnectionDescriptor(original);

    descriptor.send('frame');
    descriptor.close(1000, '🙂'.repeat(100));

    expect(descriptor.bufferedAmount()).toBe(1);
    expect(original.close).toHaveBeenCalledWith(1000, '🙂'.repeat(30));
  });
});
