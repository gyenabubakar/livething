import { describe, expect, it } from 'vitest';
import { inbox } from './inbox.ts';

describe('inbox capability — option resolution and validation', () => {
  it('defaults onDelivered to delete, receipts off, and the default audience cap', () => {
    expect(inbox({}).options).toEqual({
      onDelivered: 'delete',
      broadcastReceipts: false,
      maxReceiptAudience: 256,
    });
  });

  it('throws when onDelivered:retain is set without retention', () => {
    expect(() => inbox({ onDelivered: 'retain' } as never)).toThrow(/retention/);
  });

  it('allows retention in the default delete mode (it bounds the undelivered queue for overflow)', () => {
    expect(inbox({ retention: { maxMessages: 1 } }).options).toEqual({
      onDelivered: 'delete',
      retention: { maxMessages: 1 },
      broadcastReceipts: false,
      maxReceiptAudience: 256,
    });
  });

  it('accepts onDelivered:retain with retention', () => {
    expect(inbox({ onDelivered: 'retain', retention: { maxMessages: 100 } }).options).toEqual({
      onDelivered: 'retain',
      retention: { maxMessages: 100 },
      broadcastReceipts: false,
      maxReceiptAudience: 256,
    });
  });

  it('turns receipt broadcasting on when asked', () => {
    expect(inbox({ broadcastReceipts: true }).options.broadcastReceipts).toBe(true);
  });

  it('honors a custom maxReceiptAudience, keeping 256 as the default', () => {
    expect(inbox({ maxReceiptAudience: 50 }).options.maxReceiptAudience).toBe(50);
    expect(inbox({}).options.maxReceiptAudience).toBe(256);
  });

  it('declares its required capabilities and storage', () => {
    const primitive = inbox({});
    expect(primitive.__requires).toEqual({ storage: true });
    expect(primitive.__requiresCapabilities).toEqual([
      'channels',
      'persistence',
      'sequence',
      'dedup',
    ]);
  });

  it('__validate throws when the sequence is not persistent', () => {
    const primitive = inbox({});
    expect(() => primitive.__validate?.({ sequencePersistent: false } as never)).toThrow(
      /sequence.*persist/,
    );
    expect(() => primitive.__validate?.({ sequencePersistent: true } as never)).not.toThrow();
  });
});
