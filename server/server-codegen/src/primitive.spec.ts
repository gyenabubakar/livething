import { definePrimitive } from '~/primitive.ts';
import { describe, expect, it, vi } from 'vitest';
import type { EngineAccess } from '~/primitive.ts';

describe('definePrimitive', () => {
  // =========================================================================
  // Singleton primitives (no registrationId)
  // =========================================================================

  describe('singleton factory', () => {
    const ACK_KEY = Symbol('ack');
    const ack = definePrimitive({
      tag: 'ack',
      key: ACK_KEY,
      kind: 'infrastructure',
      create() {
        return {};
      },
    });

    it('produces correct base fields', () => {
      const p = ack();
      expect(p.__wskit).toBe('ack');
      expect(p.__kind).toBe('infrastructure');
      expect(p.__identity).toEqual([ACK_KEY]);
      expect(p.__dependencies).toEqual([]);
      expect(p.__requires).toEqual({});
    });

    it('carries __key on the factory for dependency refs', () => {
      expect(ack.__key).toBe(ACK_KEY);
    });

    it('creates distinct instances per call', () => {
      expect(ack()).not.toBe(ack());
    });
  });

  // =========================================================================
  // Repeatable primitives (with registrationId)
  // =========================================================================

  describe('repeatable factory', () => {
    const INCOMING_KEY = Symbol('incoming');
    const incoming = definePrimitive({
      tag: 'incoming',
      key: INCOMING_KEY,
      kind: 'handler',
      registrationId(event: string, _handler: () => void) {
        return event;
      },
      create(event: string, handler: () => void) {
        return { event, handler };
      },
    });

    it('produces compound identity from registrationId', () => {
      const p = incoming('send-message', () => {});
      expect(p.__identity).toEqual([INCOMING_KEY, 'send-message']);
    });

    it('carries custom data from create()', () => {
      function handler() {}
      const p = incoming('send-message', handler);
      expect(p.event).toBe('send-message');
      expect(p.handler).toBe(handler);
    });

    it('different events produce different identities', () => {
      const a = incoming('send-message', () => {});
      const b = incoming('join-room', () => {});
      expect(a.__identity[1]).toBe('send-message');
      expect(b.__identity[1]).toBe('join-room');
    });
  });

  // =========================================================================
  // Dependencies and requires
  // =========================================================================

  describe('dependencies and requires', () => {
    const seqRef = { __key: Symbol('sequence') };
    const dedupRef = { __key: Symbol('dedup') };

    const replay = definePrimitive({
      tag: 'replay',
      key: Symbol('replay'),
      kind: 'infrastructure',
      dependencies: [seqRef, dedupRef],
      requires: { storage: true },
      create() {
        return {};
      },
    });

    it('passes through dependencies', () => {
      const p = replay();
      expect(p.__dependencies).toEqual([seqRef, dedupRef]);
    });

    it('passes through requires', () => {
      const p = replay();
      expect(p.__requires).toEqual({ storage: true });
    });
  });

  // =========================================================================
  // Setup function
  // =========================================================================

  describe('setup', () => {
    it('binds setup to the primitive instance with data', () => {
      const setupFn = vi.fn();

      const heartbeat = definePrimitive({
        tag: 'heartbeat',
        key: Symbol('heartbeat'),
        kind: 'infrastructure',
        create(options: { timeout: number }) {
          return { timeout: options.timeout };
        },
        setup(_engine, data) {
          setupFn(data.timeout);
        },
      });

      const p = heartbeat({ timeout: 30000 });
      expect(p.__setup).toBeDefined();

      p.__setup!({} as EngineAccess);
      expect(setupFn).toHaveBeenCalledWith(30000);
    });

    it('is undefined when config has no setup', () => {
      const dedup = definePrimitive({
        tag: 'dedup',
        key: Symbol('dedup'),
        kind: 'infrastructure',
        create() {
          return {};
        },
      });

      expect(dedup().__setup).toBeUndefined();
    });
  });

  // =========================================================================
  // Regex pattern in registrationId
  // =========================================================================

  describe('regex registrationId', () => {
    const channel = definePrimitive({
      tag: 'channel',
      key: Symbol('channel'),
      kind: 'scope',
      registrationId(pattern: string | RegExp) {
        if (pattern instanceof RegExp) return `${pattern.source}|${pattern.flags}`;
        return String(pattern);
      },
      create(pattern: string | RegExp) {
        return { pattern };
      },
    });

    it('serializes string patterns', () => {
      expect(channel('general').__identity[1]).toBe('general');
    });

    it('serializes regex patterns', () => {
      expect(channel(/^room-/i).__identity[1]).toBe('^room-|i');
    });
  });
});
