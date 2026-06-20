/* oxlint-disable @typescript-eslint/no-explicit-any -- type test file */
// Type-only checks for the channels surface. tsc checks these; vitest never runs them.
import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { channels } from '~/primitives/channels/index.ts';

interface C {
  channels: {
    general: {
      incoming: { message: { text: string } };
      outgoing: { 'send-message': { text: string } };
    };
    rooms: {
      addressing: 'dynamic';
      incoming: { message: { text: string; from: string } };
      outgoing: { 'send-message': { text: string } };
    };
  };
}

const socket = client<C>()(connect('wss://x'), channels());

const general = socket.channel('general');
general.on('message', (data) => {
  const _t: string = data.text;
  void _t;
});
general.send('send-message', { text: 'hi' });
void general.subscribe();
general.members.get('c1');

// @ts-expect-error — 'nope' is not an event on this channel
general.on('nope', () => {});

// @ts-expect-error — 'lobby' is not a declared channel
socket.channel('lobby');

const room = socket.channel('rooms', 'room-1');
room.on('message', (data) => {
  const _from: string = data.from;
  void _from;
});

// @ts-expect-error — a fixed channel takes no second argument
socket.channel('general', 'oops');

const rooms = socket.channel.family('rooms');
const r1 = rooms('room-1');
r1.send('send-message', { text: 'x' });
rooms.on('message', (data, channelName) => {
  const _text: string = data.text;
  const _name: string = channelName;
  void _text;
  void _name;
});
const _names: string[] = rooms.list();
void _names;

// @ts-expect-error — 'general' is a fixed channel, not a family, so family() rejects it
socket.channel.family('general');
