import { LiveThingConfigError } from '@livething/core';
import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { websocket } from '~/transports/websocket.ts';
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

describe('socket.transport', () => {
  it("is 'websocket' while open, and null before and after", async () => {
    const socket = build(connect('wss://huddle.test/huddle'));
    const seen: (string | null)[] = [];
    socket.transport.subscribe((name) => seen.push(name));

    expect(socket.transport.get()).toBeNull();
    socket.connect();
    await vi.waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    expect(socket.transport.get()).toBeNull();

    MockWebSocket.last().open();
    expect(socket.transport.get()).toBe('websocket');
    expect(socket.ws).toBe(MockWebSocket.last());

    MockWebSocket.last().serverClose(1006);
    expect(socket.transport.get()).toBeNull();
    expect(socket.ws).toBeNull();
    expect(seen).toEqual(['websocket', null]);
  });

  it('is null after disconnect()', async () => {
    const socket = build(connect('wss://huddle.test/huddle'));
    socket.connect();
    await vi.waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    MockWebSocket.last().open();

    socket.disconnect();

    expect(socket.transport.get()).toBeNull();
    expect(socket.ws).toBeNull();
  });
});

describe('connect() transports', () => {
  it('connects with an explicit [websocket()]', async () => {
    const socket = build(connect('wss://huddle.test/huddle', { transports: [websocket()] }));
    socket.connect();
    await vi.waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    MockWebSocket.last().open();

    expect(socket.transport.get()).toBe('websocket');
  });

  it('refuses an empty list', () => {
    expect(() => build(connect('wss://huddle.test/huddle', { transports: [] }))).toThrow(
      LiveThingConfigError,
    );
  });

  it('refuses the same transport twice', () => {
    expect(() =>
      build(connect('wss://huddle.test/huddle', { transports: [websocket(), websocket()] })),
    ).toThrow(/twice/);
  });
});
