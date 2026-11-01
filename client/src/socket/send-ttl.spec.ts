import { LiveThingConfigError } from '@livething/core';
import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { buffering } from '~/primitives/buffering/index.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

interface C {
  outgoing: { typing: { id: string } };
}

let restore: () => void;
beforeEach(() => {
  restore = installMockWebSocket();
});
afterEach(() => {
  restore();
});

describe('send() with a per-call ttl', () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])('throws for a ttl of %s', (ttl) => {
    const socket = client<C>()(connect('wss://test'), buffering());

    expect(() => socket.send('typing', { id: 'a' }, { ttl })).toThrow(LiveThingConfigError);
  });

  it('throws on an open socket too, without a buffering primitive', () => {
    const socket = client<C>()(connect('wss://test'));
    socket.connect();
    MockWebSocket.last().open();

    expect(() => socket.send('typing', { id: 'a' }, { ttl: Number.NaN })).toThrow(
      LiveThingConfigError,
    );
  });

  it('accepts a valid ttl', () => {
    const socket = client<C>()(connect('wss://test'), buffering());

    expect(socket.send('typing', { id: 'a' }, { ttl: 1000 })).toBe(true);
  });
});
