import { incoming } from '~/primitives/incoming.ts';
import { describe, expect, it, vi } from 'vitest';

describe('incoming', () => {
  // =========================================================================
  // Base fields
  // =========================================================================

  it('produces correct tag and kind', () => {
    const p = incoming('send-message', async () => {});
    expect(p.__wskit).toBe('incoming');
    expect(p.__kind).toBe('handler');
  });

  it('produces compound identity keyed by event name', () => {
    const p = incoming('send-message', async () => {});
    expect(p.__identity[1]).toBe('send-message');
  });

  it('different events have different identities', () => {
    const a = incoming('send-message', async () => {});
    const b = incoming('join-room', async () => {});
    expect(a.__identity[1]).toBe('send-message');
    expect(b.__identity[1]).toBe('join-room');
    expect(a.__identity[0]).toBe(b.__identity[0]);
  });

  // =========================================================================
  // Event name and handler
  // =========================================================================

  it('stores the event name', () => {
    const p = incoming('send-message', async () => {});
    expect(p.event).toBe('send-message');
  });

  it('stores the handler function', () => {
    const handler = vi.fn();
    const p = incoming('send-message', handler);
    expect(p.handler).toBe(handler);
  });

  // =========================================================================
  // Validator
  // =========================================================================

  it('stores no validator when omitted', () => {
    const p = incoming('ping', async () => {});
    expect(p.validator).toBeUndefined();
  });

  it('stores a parse function validator', () => {
    function validate(p: unknown) {
      return p as { text: string };
    }
    const p = incoming('send-message', async () => {}, { validator: validate });
    expect(p.validator).toBe(validate);
  });

  it('stores a StandardSchema validator', () => {
    const schema = {
      '~standard': {
        version: 1 as const,
        vendor: 'mock',
        validate(value: unknown) {
          return { value };
        },
      },
    };
    const p = incoming('send-message', async () => {}, { validator: schema });
    expect(p.validator).toBe(schema);
  });

  // =========================================================================
  // PrimitiveRef
  // =========================================================================

  it('factory has __key for dependency references', () => {
    expect(typeof incoming.__key).toBe('symbol');
  });

  // =========================================================================
  // No dependencies or requires
  // =========================================================================

  it('has empty dependencies and requires', () => {
    const p = incoming('test', async () => {});
    expect(p.__dependencies).toEqual([]);
    expect(p.__requires).toEqual({});
  });
});
