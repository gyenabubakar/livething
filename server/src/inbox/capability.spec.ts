import { describe, expect, it } from 'vitest';
import { inbox } from './inbox.ts';

describe('inbox capability — option resolution and validation', () => {
  it('defaults afterDelivered to delete and carries no retention', () => {
    expect(inbox({}).options).toEqual({ afterDelivered: 'delete' });
  });

  it('throws when afterDelivered:keep is set without retention', () => {
    expect(() => inbox({ afterDelivered: 'keep' })).toThrow(/retention/);
  });

  it('accepts afterDelivered:keep with retention', () => {
    expect(inbox({ afterDelivered: 'keep', retention: { maxMessages: 100 } }).options).toEqual({
      afterDelivered: 'keep',
      retention: { maxMessages: 100 },
    });
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
