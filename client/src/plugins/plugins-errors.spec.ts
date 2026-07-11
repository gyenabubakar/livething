import { WSKitConfigError } from '@wskit/core';
import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { plugin } from '~/plugins/plugins.ts';
import { installMockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Primitive, ValidatePrimitives } from '~/primitives/types.ts';

interface AppContract {
  incoming: { message: { text: string } };
}

// oxlint-disable-next-line @typescript-eslint/no-explicit-any -- forward client()'s primitive constraint
function buildSocket<const P extends readonly Primitive<any, any>[]>(
  ...primitives: [...P] & ValidatePrimitives<AppContract, P>
) {
  return client<AppContract>()(connect('wss://test'), ...primitives);
}

let restore: () => void;
beforeEach(() => {
  restore = installMockWebSocket();
});
afterEach(() => {
  restore();
});

describe('Plugin.use — a failed API build is not retried', () => {
  it('remembers the error and does not re-run the builder on later use() calls', () => {
    const builder = vi.fn(() => {
      throw new Error('build failed');
    });
    const Failing = plugin<{}, unknown>({
      id: 'acme:failing',
      setup: () => ({ api: builder }),
    });

    const socket = buildSocket(Failing());

    expect(() => Failing.use(socket)).toThrow('build failed');
    expect(() => Failing.use(socket)).toThrow('build failed');
    expect(builder).toHaveBeenCalledTimes(1);
  });
});

describe('Plugin.use — not registered', () => {
  it('throws when the plugin was never passed to client()', () => {
    const Chat = plugin<{}, { ok: true }>({
      id: 'acme:chat',
      setup: () => ({ api: () => ({ ok: true }) }),
    });

    const socket = buildSocket(); // Chat intentionally omitted

    expect(() => Chat.use(socket)).toThrow(WSKitConfigError);
    expect(() => Chat.use(socket)).toThrow(/not registered on this socket/);
  });

  it('throws for an observe-only plugin that exposes no API', () => {
    const Watcher = plugin({ id: 'acme:watcher', setup: () => ({}) });

    const socket = buildSocket(Watcher());

    expect(() => Watcher.use(socket)).toThrow(/exposes no API/);
  });
});
