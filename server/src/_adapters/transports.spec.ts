import { LiveThingConfigError } from '@livething/core';
import { resolveTransports, websocket } from '~/_adapters/transports.ts';
import { describe, expect, it } from 'vitest';
import type { ServerTransport } from '~/_adapters/transports.ts';

describe('resolveTransports', () => {
  it('offers WebSocket only when the option is left out', () => {
    expect([...resolveTransports(undefined)]).toEqual(['websocket']);
  });

  it('offers the one transport a list names', () => {
    expect([...resolveTransports([websocket()])]).toEqual(['websocket']);
  });

  it('refuses an empty list', () => {
    expect(() => resolveTransports([])).toThrow(LiveThingConfigError);
    expect(() => resolveTransports([])).toThrow(/at least one transport/);
  });

  it('refuses the same transport twice', () => {
    expect(() => resolveTransports([websocket(), websocket()])).toThrow(/twice/);
  });

  it.each([[{ name: 'carrier-pigeon' }], [{}], [null], ['websocket']])(
    'refuses %j, which is not a transport',
    (transport) => {
      expect(() => resolveTransports([transport as unknown as ServerTransport])).toThrow(
        /not a transport/,
      );
    },
  );
});
