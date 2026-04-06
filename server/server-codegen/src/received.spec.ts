import { isReceivedEvent, received } from '~/received.ts';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

describe('received', () => {
  it('stores the event name', () => {
    const event = received('send-message');
    expect(event.event).toBe('send-message');
  });

  it('stores no validator when omitted', () => {
    const event = received('send-message');
    expect(event.validator).toBeUndefined();
  });

  it('stores a parse function validator', () => {
    function validate(value: unknown) {
      return value as { text: string };
    }

    const event = received('send-message', validate);
    expect(event.validator).toBe(validate);
  });

  it('stores a valibot schema', () => {
    const schema = v.object({ text: v.string() });
    const event = received('send-message', schema);
    expect(event.validator).toBe(schema);
  });

  it('stores a zod schema', () => {
    const schema = z.object({ text: z.string() });
    const event = received('send-message', schema);
    expect(event.validator).toBe(schema);
  });

  it('marks the contract with the received tag', () => {
    const event = received('send-message');
    expect(event.__wskit).toBe('received');
  });

  it('detects received(...) contracts', () => {
    expect(isReceivedEvent(received('send-message'))).toBe(true);
    expect(isReceivedEvent({ event: 'send-message' })).toBe(false);
    expect(isReceivedEvent('send-message')).toBe(false);
  });
});
