import { LiveThingConfigError } from '@livething/core';
import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { buffering } from '~/primitives/buffering/index.ts';
import { describe, expect, it } from 'vitest';
import type { BufferingOptions } from '~/primitives/buffering/buffering.ts';
import type { SocketContract } from '~/types.ts';

function build(options: BufferingOptions) {
  return client<SocketContract>()(connect('wss://test'), buffering(options));
}

describe('buffering() config checks', () => {
  it('throws for a ttl of NaN', () => {
    expect(() => build({ ttl: Number.NaN })).toThrow(LiveThingConfigError);
  });

  it.each([Number.NaN, -1, Number.POSITIVE_INFINITY])(
    'throws for a flushInterval of %s',
    (flushInterval) => {
      expect(() => build({ flushInterval })).toThrow(LiveThingConfigError);
    },
  );

  it('accepts a valid ttl and flushInterval', () => {
    expect(() => build({ ttl: 5000, flushInterval: 100 })).not.toThrow();
  });

  it('rejects a bad maxMessages or maxBytes through the same path', () => {
    expect(() => build({ maxMessages: 0 })).toThrow(LiveThingConfigError);
    expect(() => build({ maxBytes: 0 })).toThrow(LiveThingConfigError);
  });
});
