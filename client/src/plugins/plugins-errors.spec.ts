import { WSKitConfigError } from '@wskit/core';
import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { plugin } from '~/plugins/plugins.ts';
import { installMockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Primitive, ValidatePrimitives } from '~/primitives/types.ts';

interface C {
  incoming: { message: { text: string } };
  outgoing: { ping: Record<string, never> };
}

// oxlint-disable-next-line @typescript-eslint/no-explicit-any -- forward client()'s primitive constraint
function buildSocket<const P extends readonly Primitive<any, any>[]>(
  ...primitives: [...P] & ValidatePrimitives<C, P>
) {
  return client<C>()(connect('wss://test'), ...primitives);
}

let restore: () => void;
beforeEach(() => {
  restore = installMockWebSocket();
});
afterEach(() => {
  restore();
});

describe('Plugin.use — not-registered error branches', () => {
  it('throws WSKitConfigError with the singleton message when the plugin was never passed to client()', () => {
    const KEY = Symbol('acme:singleton');
    const Singleton = plugin({ id: 'acme:singleton', key: KEY, setup: () => () => ({}) });

    const socket = buildSocket(); // Singleton intentionally omitted

    expect(() => Singleton.use(socket)).toThrow(WSKitConfigError);
    expect(() => Singleton.use(socket)).toThrow(
      'this plugin is not registered on this socket. Pass it to client().',
    );
  });

  it('throws WSKitConfigError with the keyed message when no instance matches the registrationId', () => {
    const KEY = Symbol('acme:repeatable');
    const Repeatable = plugin<{ tracker: string }, { tracker: string }>({
      id: 'acme:repeatable',
      key: KEY,
      registrationId: (args) => args.tracker,
      setup: (args) => () => ({ tracker: args.tracker }),
    });

    // Register only 'ga'; ask for 'mixpanel' which was never registered.
    const socket = buildSocket(Repeatable({ tracker: 'ga' }));

    expect(() => Repeatable.use(socket, 'mixpanel')).toThrow(WSKitConfigError);
    expect(() => Repeatable.use(socket, 'mixpanel')).toThrow(
      "no plugin instance with registrationId 'mixpanel' is registered on this socket.",
    );
  });
});
