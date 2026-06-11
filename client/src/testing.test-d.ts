/* oxlint-disable @typescript-eslint/no-explicit-any -- type test file */
// Type-only checks for the `inject*` testing helpers. tsc checks these; vitest
// never runs them. They prove the helpers reject unknown events, unknown
// channels, and wrong payload shapes at compile time — the runtime routing is
// covered separately in testing-routing.spec.ts.
import { inject, injectChannel } from '~/testing.ts';
import type { Socket } from '~/socket/api.ts';

interface C {
  incoming: { ping: { id: string } };
  channels: {
    general: {
      incoming: { message: { text: string } };
      outgoing: { send: { text: string } };
    };
  };
}

declare const socket: Socket<C>;

// inject — top-level incoming
inject(socket, 'ping', { id: 'x' });
// @ts-expect-error wrong payload shape
inject(socket, 'ping', { id: 123 });
// @ts-expect-error unknown event name
inject(socket, 'nope', { id: 'x' });

// injectChannel — channel-scoped incoming
injectChannel(socket, 'general', 'message', { text: 'hi' });
// @ts-expect-error wrong payload shape
injectChannel(socket, 'general', 'message', { text: 123 });
// @ts-expect-error unknown event on a known channel
injectChannel(socket, 'general', 'nope', { text: 'hi' });
// @ts-expect-error unknown channel
injectChannel(socket, 'nope', 'message', { text: 'hi' });
