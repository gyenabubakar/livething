import { createPrimitiveBase } from '~/primitive.ts';
import { describe, expect, it } from 'vitest';
import type { PrimitiveDefinition } from '~/primitive.ts';

// ===========================================================================
// createPrimitiveBase
// ===========================================================================

describe('createPrimitiveBase', () => {
  const ACK_KEY = Symbol('ack');
  const INCOMING_KEY = Symbol('incoming');

  it('creates singleton identity when no registrationId', () => {
    const base = createPrimitiveBase({
      tag: 'ack',
      key: ACK_KEY,
      kind: 'infrastructure',
    });

    expect(base.__wskit).toBe('ack');
    expect(base.__kind).toBe('infrastructure');
    expect(base.__identity).toEqual([ACK_KEY]);
    expect(base.__dependencies).toEqual([]);
    expect(base.__requires).toEqual({});
  });

  it('creates compound identity when registrationId is provided', () => {
    const base = createPrimitiveBase(
      {
        tag: 'incoming',
        key: INCOMING_KEY,
        kind: 'handler',
        registrationId(event: string) {
          return event;
        },
      },
      'send-message',
    );

    expect(base.__wskit).toBe('incoming');
    expect(base.__identity).toEqual([INCOMING_KEY, 'send-message']);
  });

  it('passes through dependencies', () => {
    const seqRef = { __key: Symbol('sequence') };
    const dedupRef = { __key: Symbol('dedup') };

    const base = createPrimitiveBase({
      tag: 'replay',
      key: Symbol('replay'),
      kind: 'infrastructure',
      dependencies: [seqRef, dedupRef],
    });

    expect(base.__dependencies).toEqual([seqRef, dedupRef]);
  });

  it('passes through requires', () => {
    const base = createPrimitiveBase({
      tag: 'scheduled',
      key: Symbol('scheduled'),
      kind: 'infrastructure',
      requires: { storage: true, timers: true },
    });

    expect(base.__requires).toEqual({ storage: true, timers: true });
  });

  it('defaults dependencies and requires to empty', () => {
    const base = createPrimitiveBase({
      tag: 'dedup',
      key: Symbol('dedup'),
      kind: 'infrastructure',
    });

    expect(base.__dependencies).toEqual([]);
    expect(base.__requires).toEqual({});
  });

  it('serializes regex patterns in registrationId', () => {
    const def: PrimitiveDefinition<'channel', [pattern: string | RegExp]> = {
      tag: 'channel',
      key: Symbol('channel'),
      kind: 'scope',
      registrationId(pattern: string | RegExp) {
        if (pattern instanceof RegExp) return `${pattern.source}|${pattern.flags}`;
        return String(pattern);
      },
    };

    const stringBase = createPrimitiveBase(def, 'general');
    expect(stringBase.__identity[1]).toBe('general');

    const regexBase = createPrimitiveBase(def, /^room-/i);
    expect(regexBase.__identity[1]).toBe('^room-|i');
  });
});
