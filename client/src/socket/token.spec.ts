/* oxlint-disable @typescript-eslint/no-explicit-any */
import { encodeBase64Url } from '@livething/core';
import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SocketContract } from '~/types.ts';

let restore: () => void;
beforeEach(() => {
  restore = installMockWebSocket();
});
afterEach(() => {
  restore();
});

const build = client<SocketContract>();

describe('connect() with a token', () => {
  it('offers livething-v1 and the encoded token', async () => {
    const socket = build(connect('wss://huddle.test/huddle', { token: () => 'session-8f2c' }));

    socket.connect();
    await vi.waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));

    expect(MockWebSocket.last().protocols).toEqual([
      'livething-v1',
      `livething-v1.token.${encodeBase64Url('session-8f2c')}`,
    ]);
  });

  it("offers the app's own protocols first and the token last", async () => {
    const socket = build(
      connect('wss://huddle.test/huddle', {
        protocols: ['huddle.v2'],
        token: async () => 'session-8f2c',
      }),
    );

    socket.connect();
    await vi.waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));

    expect(MockWebSocket.last().protocols).toEqual([
      'huddle.v2',
      `livething-v1.token.${encodeBase64Url('session-8f2c')}`,
    ]);
  });

  it("offers only the app's protocols when the token function returns nothing", async () => {
    const socket = build(
      connect('wss://huddle.test/huddle', { protocols: ['huddle.v2'], token: () => null }),
    );

    socket.connect();
    await vi.waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));

    expect(MockWebSocket.last().protocols).toEqual(['huddle.v2']);
  });

  it('runs the token function again on every reconnect', async () => {
    let count = 0;
    const token = vi.fn(() => `session-${++count}`);
    const socket = build(connect('wss://huddle.test/huddle', { token }));

    socket.connect();
    await vi.waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    MockWebSocket.last().open('livething-v1');

    socket.disconnect();
    socket.connect();
    await vi.waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));

    expect(token).toHaveBeenCalledTimes(2);
    expect(MockWebSocket.last().protocols).toContain(
      `livething-v1.token.${encodeBase64Url('session-2')}`,
    );
  });

  it('reports a clear error when the token function returns something other than a string', async () => {
    const socket = build(connect('wss://huddle.test/huddle', { token: (() => 42) as any }));
    const errors: unknown[] = [];
    socket.onError((error) => errors.push(error));

    socket.connect();
    await vi.waitFor(() => expect(errors).toHaveLength(1));

    expect((errors[0] as Error).message).toMatch(/token/);
    expect(MockWebSocket.instances).toHaveLength(0);
  });
});

describe('socket.protocol', () => {
  it('hides the LiveThing names', async () => {
    const socket = build(connect('wss://huddle.test/huddle', { token: () => 'session-8f2c' }));

    socket.connect();
    await vi.waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    MockWebSocket.last().open('livething-v1');

    expect(socket.protocol).toBeNull();
  });

  it("shows the app's own name that the server accepted", async () => {
    const socket = build(
      connect('wss://huddle.test/huddle', { protocols: ['huddle.v2'], token: () => 'session' }),
    );

    socket.connect();
    await vi.waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    MockWebSocket.last().open('huddle.v2');

    expect(socket.protocol).toBe('huddle.v2');
  });
});
