/* oxlint-disable @typescript-eslint/no-explicit-any */
import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { installMockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SocketContract } from '~/types.ts';

let restore: () => void;
beforeEach(() => {
  restore = installMockWebSocket();
});
afterEach(() => {
  restore();
});

describe('connect() with a URL function', () => {
  it.each([
    ['a number', 42],
    ['undefined', undefined],
    ['null', null],
  ])('reports a clear error when it returns %s', async (_name, value) => {
    const socket = client<SocketContract>()(connect((() => value) as any));
    const errors: unknown[] = [];
    socket.onError((error) => errors.push(error));

    socket.connect();
    await vi.waitFor(() => expect(errors).toHaveLength(1));

    const message = (errors[0] as Error).message;
    expect(errors[0]).not.toBeInstanceOf(TypeError);
    expect(message).toMatch(/\[livething\]/);
    expect(message).toMatch(/url/i);
    expect(message).toMatch(/string/i);
  });
});
