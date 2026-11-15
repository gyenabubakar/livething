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
injectChannel(socket, 'message', {
  channel: { family: 'rooms', name: 'room:general' },
  payload: { text: 'hi' },
});
// @ts-expect-error a dynamic family needs { family, name }
injectChannel(socket, 'message', { channel: 'rooms', payload: { text: 'hi' } });
injectChannel(socket, 'message', {
  // @ts-expect-error a fixed channel is named by its name
  channel: { family: 'general', name: 'general' },
  payload: { text: 'hi' },
});
declare const generalOrRooms: 'general' | 'rooms';
// @ts-expect-error a union that holds a dynamic family still needs { family, name } for it
injectChannel(socket, 'message', { channel: generalOrRooms, payload: { text: 'hi' } });

inject(socket, 'ping', { id: 'x' });
// @ts-expect-error wrong payload shape
inject(socket, 'ping', { id: 123 });
// @ts-expect-error unknown event name
inject(socket, 'nope', { id: 'x' });

injectChannel(socket, 'message', { channel: 'general', payload: { text: 'hi' } });
// @ts-expect-error wrong payload shape
injectChannel(socket, 'message', { channel: 'general', payload: { text: 123 } });
// @ts-expect-error unknown event on a known channel
injectChannel(socket, 'nope', { channel: 'general', payload: { text: 'hi' } });
// @ts-expect-error unknown channel
injectChannel(socket, 'message', { channel: 'nope', payload: { text: 'hi' } });

const realSocket = client<C>()(connect('wss://test'), channels());

inject(realSocket, 'ping', { id: 'x' });
// @ts-expect-error wrong payload shape on the real socket
inject(realSocket, 'ping', { id: 123 });
// @ts-expect-error unknown event on the real socket
inject(realSocket, 'nope', { id: 'x' });

injectChannel(realSocket, 'message', { channel: 'general', payload: { text: 'hi' } });
// @ts-expect-error wrong payload shape on the real socket
injectChannel(realSocket, 'message', { channel: 'general', payload: { text: 123 } });
// @ts-expect-error unknown event on a known channel of the real socket
injectChannel(realSocket, 'nope', { channel: 'general', payload: { text: 'hi' } });
// @ts-expect-error unknown channel on the real socket
injectChannel(realSocket, 'message', { channel: 'nope', payload: { text: 'hi' } });
