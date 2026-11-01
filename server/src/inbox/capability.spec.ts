import { describe, expect, it } from 'vitest';
import { inbox, resolveInboxOptions } from './inbox.ts';

describe('inbox capability — option resolution and validation', () => {
  it('defaults receipts off and the default audience cap', () => {
    expect(resolveInboxOptions({})).toEqual({
      broadcastReceipts: false,
      maxReceiptAudience: 256,
    });
  });

  it('keeps retention (it bounds the undelivered queue for overflow)', () => {
    expect(resolveInboxOptions({ retention: { maxMessages: 1 } })).toEqual({
      retention: { maxMessages: 1 },
      broadcastReceipts: false,
      maxReceiptAudience: 256,
    });
  });

  it('rejects non-positive or non-integer retention bounds', () => {
    expect(() => inbox({ retention: { maxAgeMs: 0 } })).toThrow(/retention\.maxAgeMs/);
    expect(() => inbox({ retention: { maxMessages: 1.5 } })).toThrow(/retention\.maxMessages/);
  });

  it('turns receipt broadcasting on when asked', () => {
    expect(resolveInboxOptions({ broadcastReceipts: true }).broadcastReceipts).toBe(true);
  });

  it('honors a custom maxReceiptAudience, keeping 256 as the default', () => {
    expect(resolveInboxOptions({ maxReceiptAudience: 50 }).maxReceiptAudience).toBe(50);
    expect(resolveInboxOptions({}).maxReceiptAudience).toBe(256);
  });

  it('declares its required capabilities', () => {
    const primitive = inbox({});
    expect(primitive.__requires).toEqual({});
    expect(primitive.__requiresCapabilities).toEqual(['channels', 'sequence', 'dedup']);
  });

  it('__validate throws when the sequence is not persistent', () => {
    const primitive = inbox({});
    expect(() => primitive.__validate?.({ sequencePersistent: false } as never)).toThrow(
      'List sequence({ persist: true }) in server({ capabilities: [...] }) instead of sequence().',
    );
    expect(() => primitive.__validate?.({ sequencePersistent: true } as never)).not.toThrow();
  });
});
