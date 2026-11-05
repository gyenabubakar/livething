/* oxlint-disable @typescript-eslint/no-explicit-any -- type test file */
// Type-only checks for the `inject*` testing helpers. tsc checks these; vitest
// never runs them. They prove the helpers reject unknown events, unknown
// channels, and wrong payload shapes at compile time — the runtime routing is
// covered separately in testing-routing.spec.ts.
import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { channels } from '~/primitives/channels/index.ts';
import { inject, injectChannel } from '~/testing.ts';
import type { Socket } from '~/socket/api.ts';

interface C {
  incoming: { ping: { id: string } };
  channels: {
    general: {
      incoming: { message: { text: string } };
      outgoing: { send: { text: string } };
    };
    rooms: {
      addressing: 'dynamic';
      incoming: { message: { text: string } };
    };
  };
}

declare const socket: Socket<C>;

// A dynamic family is named with { family, name }; the family name alone reaches no handle.
injectChannel(socket, { family: 'rooms', name: 'room:general' }, 'message', { text: 'hi' });
// @ts-expect-error a dynamic family needs { family, name }
injectChannel(socket, 'rooms', 'message', { text: 'hi' });
// @ts-expect-error a fixed channel is named by its name
injectChannel(socket, { family: 'general', name: 'general' }, 'message', { text: 'hi' });

inject(socket, 'ping', { id: 'x' });
// @ts-expect-error wrong payload shape
inject(socket, 'ping', { id: 123 });
// @ts-expect-error unknown event name
inject(socket, 'nope', { id: 'x' });

injectChannel(socket, 'general', 'message', { text: 'hi' });
// @ts-expect-error wrong payload shape
injectChannel(socket, 'general', 'message', { text: 123 });
// @ts-expect-error unknown event on a known channel
injectChannel(socket, 'general', 'nope', { text: 'hi' });
// @ts-expect-error unknown channel
injectChannel(socket, 'nope', 'message', { text: 'hi' });

const realSocket = client<C>()(connect('wss://test'), channels());

inject(realSocket, 'ping', { id: 'x' });
// @ts-expect-error wrong payload shape on the real socket
inject(realSocket, 'ping', { id: 123 });
// @ts-expect-error unknown event on the real socket
inject(realSocket, 'nope', { id: 'x' });

injectChannel(realSocket, 'general', 'message', { text: 'hi' });
// @ts-expect-error wrong payload shape on the real socket
injectChannel(realSocket, 'general', 'message', { text: 123 });
// @ts-expect-error unknown event on a known channel of the real socket
injectChannel(realSocket, 'general', 'nope', { text: 'hi' });
// @ts-expect-error unknown channel on the real socket
injectChannel(realSocket, 'nope', 'message', { text: 'hi' });
