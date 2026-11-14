import { LiveThingConfigError } from '@livething/core';
import { hasCapability, resolveTransports, sse, websocket } from '~/_adapters/transports.ts';
import { server } from '~/_define/server.ts';
import { keepalive } from '~/keepalive/capability.ts';
import { describe, expect, it } from 'vitest';
import type { ServerTransport } from '~/_adapters/transports.ts';
import type { ServerDefinition } from '~/server-definition.ts';

const plain = server({}).assemble({ handlers: [] }) as ServerDefinition;
const withKeepalive = server({ capabilities: [keepalive()] }).assemble({
  handlers: [],
}) as ServerDefinition;

describe('resolveTransports', () => {
  it('offers WebSocket only when the option is left out', () => {
    expect(resolveTransports(undefined, plain)).toEqual({
      websocket: true,
      sse: null,
      custom: [],
    });
  });

  it('offers the one transport a list names', () => {
    expect(resolveTransports([websocket()], plain)).toEqual({
      websocket: true,
      sse: null,
      custom: [],
    });
  });

  it('offers sse() with its default maxPostBytes of 512 KiB', () => {
    expect(resolveTransports([sse()], withKeepalive)).toEqual({
      websocket: false,
      sse: { maxPostBytes: 512 * 1024 },
      custom: [],
    });
  });

  it('offers both, in any order', () => {
    expect(resolveTransports([sse({ maxPostBytes: 1000 }), websocket()], withKeepalive)).toEqual({
      websocket: true,
      sse: { maxPostBytes: 1000 },
      custom: [],
    });
  });

  it('offers a custom transport, and keeps the custom ones in list order', () => {
    const longPolling = { name: 'long-polling', handle: async () => null };
    const carrier = { name: 'carrier', handle: async () => null };

    expect(resolveTransports([websocket(), longPolling, carrier], plain)).toEqual({
      websocket: true,
      sse: null,
      custom: [longPolling, carrier],
    });
  });

  it("runs a custom transport's check() with the definition at startup", () => {
    const longPolling: ServerTransport = {
      name: 'long-polling',
      handle: async () => null,
      check(definition) {
        if (!hasCapability(definition, 'keepalive')) {
          throw new LiveThingConfigError('long-polling needs keepalive()');
        }
      },
    };

    expect(() => resolveTransports([longPolling], plain)).toThrow(/long-polling needs keepalive/);
    expect(resolveTransports([longPolling], withKeepalive).custom).toEqual([longPolling]);
  });

  it('refuses a custom transport with a built-in name', () => {
    const fake = { name: 'sse', handle: async () => null };

    expect(() => resolveTransports([fake], withKeepalive)).toThrow(
      /'sse' is the name of a built-in/,
    );
  });

  it('refuses a custom transport with an empty name', () => {
    expect(() => resolveTransports([{ name: '', handle: async () => null }], plain)).toThrow(
      /not a transport/,
    );
  });

  it('refuses sse() on a definition without keepalive()', () => {
    expect(() => resolveTransports([websocket(), sse()], plain)).toThrow(
      /sse\(\), which needs keepalive\(\)/,
    );
  });

  it('refuses an empty list', () => {
    expect(() => resolveTransports([], plain)).toThrow(LiveThingConfigError);
    expect(() => resolveTransports([], plain)).toThrow(/at least one transport/);
  });

  it('refuses the same transport twice', () => {
    expect(() => resolveTransports([websocket(), websocket()], plain)).toThrow(/twice/);
  });

  it.each([[{ name: 'carrier-pigeon' }], [{}], [null], ['websocket']])(
    'refuses %j, which is not a transport',
    (transport) => {
      expect(() => resolveTransports([transport as unknown as ServerTransport], plain)).toThrow(
        /not a transport/,
      );
    },
  );
});

describe('sse()', () => {
  it.each([0, -1, 1.5, Number.NaN])('refuses maxPostBytes %s', (maxPostBytes) => {
    expect(() => sse({ maxPostBytes })).toThrow(/maxPostBytes must be a whole number/);
  });
});

describe('hasCapability', () => {
  it('finds a capability in the definition', () => {
    expect(hasCapability(withKeepalive, 'keepalive')).toBe(true);
    expect(hasCapability(plain, 'keepalive')).toBe(false);
  });
});
