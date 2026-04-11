import { incoming } from '~/incoming/incoming.ts';
import { received } from '~/received.ts';
import * as v from 'valibot';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

describe('incoming', () => {
  // =========================================================================
  // Base fields
  // =========================================================================

  it('produces correct tag and kind', () => {
    const p = incoming(received('send-message'), async () => {});
    expect(p.__wskit).toBe('incoming');
    expect(p.__kind).toBe('handler');
  });

  it('produces compound identity keyed by event name', () => {
    const p = incoming(received('send-message'), async () => {});
    expect(p.__identity[1]).toBe('send-message');
  });

  it('different events have different identities', () => {
    const a = incoming(received('send-message'), async () => {});
    const b = incoming(received('join-room'), async () => {});
    expect(a.__identity[1]).toBe('send-message');
    expect(b.__identity[1]).toBe('join-room');
    expect(a.__identity[0]).toBe(b.__identity[0]);
  });

  // =========================================================================
  // Event name and handler
  // =========================================================================

  it('stores the event name', () => {
    const p = incoming(received('send-message'), async () => {});
    expect(p.event).toBe('send-message');
  });

  it('reads the event name from received(...)', () => {
    const p = incoming(received('send-message'), async () => {});
    expect(p.event).toBe('send-message');
  });

  it('stores the handler function', () => {
    const handler = vi.fn();
    const p = incoming(received('send-message'), handler);
    expect(p.handler).toBe(handler);
  });

  // =========================================================================
  // Validator
  // =========================================================================

  it('stores no validator when omitted', () => {
    const p = incoming(received('ping'), async () => {});
    expect(p.validator).toBeUndefined();
  });

  it('stores a parse function validator', () => {
    function validate(p: unknown) {
      return p as { text: string };
    }
    const p = incoming(received('send-message', validate), async () => {});
    expect(p.validator).toBe(validate);
  });

  it('reads the validator from received(...)', () => {
    function validate(p: unknown) {
      return p as { text: string };
    }

    const p = incoming(received('send-message', validate), async () => {});
    expect(p.validator).toBe(validate);
  });

  it('stores a valibot schema', () => {
    const schema = v.object({ text: v.string() });
    const p = incoming(received('send-message', schema), async (_ctx, payload) => {
      const _text: string = payload.text;
      void _text;
    });
    expect(p.validator).toBe(schema);
  });

  it('stores a zod schema', () => {
    const schema = z.object({ text: z.string() });
    const p = incoming(received('send-message', schema), async (_ctx, payload) => {
      const _text: string = payload.text;
      void _text;
    });
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
    const p = incoming(received('test'), async () => {});
    expect(p.__dependencies).toEqual([]);
    expect(p.__requires).toEqual({});
  });
});
