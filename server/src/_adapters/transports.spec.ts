import { LiveThingConfigError } from '@livething/core';
import { hasCapability, http, resolveTransports, websocket } from '~/_adapters/transports.ts';
import { server } from '~/_define/server.ts';
import { keepalive } from '~/keepalive/capability.ts';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { ServerTransport, TransportConnection } from '~/_adapters/transports.ts';
import type { ServerDefinition } from '~/server-definition.ts';

const plain = server({}).assemble({ handlers: [] }) as ServerDefinition;
const withKeepalive = server({ capabilities: [keepalive()] }).assemble({
  handlers: [],
}) as ServerDefinition;

describe('resolveTransports', () => {
  it('offers WebSocket only when the option is left out', () => {
    expect(resolveTransports(undefined, plain)).toEqual({
      websocket: true,
      http: null,
      custom: [],
    });
  });

  it('offers the one transport a list names', () => {
    expect(resolveTransports([websocket()], plain)).toEqual({
      websocket: true,
      http: null,
      custom: [],
    });
  });

  it('offers http() with its default maxPostBytes of 512 KiB', () => {
    expect(resolveTransports([http()], withKeepalive)).toEqual({
      websocket: false,
      http: { maxPostBytes: 512 * 1024 },
      custom: [],
    });
  });

  it('offers both, in any order', () => {
    expect(resolveTransports([http({ maxPostBytes: 1000 }), websocket()], withKeepalive)).toEqual({
      websocket: true,
      http: { maxPostBytes: 1000 },
      custom: [],
    });
  });

  it('offers a custom transport, and keeps the custom ones in list order', () => {
    const longPolling = { name: 'long-polling', handle: async () => null };
    const carrier = { name: 'carrier', handle: async () => null };

    expect(resolveTransports([websocket(), longPolling, carrier], plain)).toEqual({
      websocket: true,
      http: null,
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
    const fake = { name: 'http', handle: async () => null };

    expect(() => resolveTransports([fake], withKeepalive)).toThrow(
      /'http' is the name of a built-in/,
    );
  });

  it('refuses a custom transport with an empty name', () => {
    expect(() => resolveTransports([{ name: '', handle: async () => null }], plain)).toThrow(
      /not a transport/,
    );
  });

  it('refuses http() on a definition without keepalive()', () => {
    expect(() => resolveTransports([websocket(), http()], plain)).toThrow(
      /http\(\), which needs keepalive\(\)/,
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

describe('http()', () => {
  it.each([0, -1, 1.5, Number.NaN])('refuses maxPostBytes %s', (maxPostBytes) => {
    expect(() => http({ maxPostBytes })).toThrow(/maxPostBytes must be a whole number/);
  });
});

describe('hasCapability', () => {
  it('finds a capability in the definition', () => {
    expect(hasCapability(withKeepalive, 'keepalive')).toBe(true);
    expect(hasCapability(plain, 'keepalive')).toBe(false);
  });
});

describe('TransportConnection', () => {
  // The engine reads only a synchronous `false` as not sent, so a Promise would count as sent.
  it('takes a send that returns a boolean or nothing, not a Promise', () => {
    expectTypeOf<ReturnType<TransportConnection['send']>>().toEqualTypeOf<boolean | void>();
  });
});
