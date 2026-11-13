/* oxlint-disable no-unused-vars */
// Compile-time checks for the client `binary()` primitive. tsc checks these; vitest
// never runs them. The contract is shaped like `InferClient` output for Huddle.
import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { plugin } from '~/plugins/plugins.ts';
import { binary } from '~/primitives/binary/index.ts';
import { channels } from '~/primitives/channels/index.ts';
import { stream } from '~/primitives/stream/index.ts';
import { injectBinary, injectChannelBinary } from '~/testing.ts';
import { expectTypeOf } from 'vitest';
import type { Socket } from '~/socket/api.ts';
import type { ScopeContract, SocketContract } from '~/types.ts';

interface HuddleSocket {
  incoming: { 'avatar-saved': { userId: string } };
  outgoing: { 'save-avatar': { userId: string } };
  binary: {
    incoming: { 'avatar-preview': null; 'avatar-cropped': { width: number } };
    outgoing: { 'upload-avatar': { fileType: 'image/png' | 'image/jpeg' } };
    clientRequests: {};
    serverRequests: {};
    streams: {};
  };
  channels: {
    rooms: {
      addressing: 'dynamic';
      incoming: { 'screen-share-started': { from: string } };
      outgoing: {};
      binary: {
        incoming: { 'screen-frame': { from: string } };
        outgoing: { 'share-screen-frame': null };
        clientRequests: {};
        serverRequests: {};
        streams: {};
      };
    };
    lobby: { incoming: { notice: { text: string } } };
  };
}

const socket = client<HuddleSocket>()(
  connect('wss://huddle.example.com/huddle'),
  binary(),
  channels(),
);
const picture = new Uint8Array([137, 80, 78, 71]);

// Top-level listeners: the info type, then a Uint8Array.
socket.binary.on('avatar-cropped', (info, bytes) => {
  expectTypeOf(info).toEqualTypeOf<{ width: number }>();
  expectTypeOf(bytes).toEqualTypeOf<Uint8Array>();
});
socket.binary.on('avatar-preview', (info) => {
  expectTypeOf(info).toEqualTypeOf<null>();
});
expectTypeOf(socket.binary.on('avatar-preview', () => {})).toEqualTypeOf<() => void>();
// @ts-expect-error: 'avatar-saved' is a JSON event, not a binary one
socket.binary.on('avatar-saved', () => {});
// @ts-expect-error: 'avatar-preview' is a binary event, not a JSON one
socket.on('avatar-preview', () => {});

// Top-level sends: the info type, optional bytes, optional options; returns boolean.
expectTypeOf(
  socket.binary.send('upload-avatar', { fileType: 'image/png' }, picture),
).toEqualTypeOf<boolean>();
socket.binary.send('upload-avatar', { fileType: 'image/jpeg' }, picture.buffer as ArrayBuffer);
socket.binary.send('upload-avatar', { fileType: 'image/png' });
socket.binary.send('upload-avatar', { fileType: 'image/png' }, undefined, { ttl: 5_000 });
// @ts-expect-error: wrong info type
socket.binary.send('upload-avatar', { fileType: 'image/gif' }, picture);
// @ts-expect-error: the bytes must be a Uint8Array or an ArrayBuffer
socket.binary.send('upload-avatar', { fileType: 'image/png' }, 'bytes');
// @ts-expect-error: a received event cannot be sent
socket.binary.send('avatar-preview', null);

// Channel handles get `.binary` from the channel's own binary entries.
const general = socket.channel('rooms', 'room:general');
general.binary.on('screen-frame', (info, bytes) => {
  expectTypeOf(info).toEqualTypeOf<{ from: string }>();
  expectTypeOf(bytes).toEqualTypeOf<Uint8Array>();
});
general.binary.send('share-screen-frame', null, picture);
// @ts-expect-error: 'avatar-preview' belongs to the top level
general.binary.on('avatar-preview', () => {});
// A channel with no binary entries has no `.binary`.
// @ts-expect-error: lobby has no binary entries
socket.channel('lobby').binary;

// socket.drain() is part of every socket, with or without binary().
expectTypeOf(socket.drain()).toEqualTypeOf<Promise<void>>();
expectTypeOf(client()(connect('wss://x')).drain()).toEqualTypeOf<Promise<void>>();

// A contract with binary entries needs binary(), at the top level or in a channel.
// @ts-expect-error: this server sends binary. Register binary() in client().
client<HuddleSocket>()(connect('wss://huddle.example.com/huddle'), channels(), stream());

interface OnlyChannelBinary {
  channels: { rooms: { binary: { incoming: { 'screen-frame': { from: string } } } } };
}

// @ts-expect-error: a channel's binary entries need binary() too
client<OnlyChannelBinary>()(connect('wss://huddle.example.com/huddle'), channels());
client<OnlyChannelBinary>()(connect('wss://huddle.example.com/huddle'), channels(), binary());

// A wrapper generic over the contract cannot be checked, so it casts.
export function wrapWithoutBinary<TContract extends SocketContract>(url: string): void {
  // @ts-expect-error: the contract is unknown, so it may need binary()
  client<TContract>()(connect(url));
  client<TContract>()(connect(url) as never);
}

// A loose contract (`any`, or an index signature) has no known binary entries: no binary() needed.
// oxlint-disable-next-line @typescript-eslint/no-explicit-any -- the loose contract under test
client<any>()(connect('wss://huddle.example.com/huddle'));
// oxlint-disable-next-line @typescript-eslint/no-explicit-any -- the loose contract under test
client<Record<string, any>>()(connect('wss://huddle.example.com/huddle'));
client<{ [key: string]: unknown; channels: Record<string, {}> }>()(
  connect('wss://huddle.example.com/huddle'),
);

// An index signature next to a real binary key still asks for binary().
interface Mixed {
  [key: string]: unknown;
  binary: { incoming: { 'avatar-preview': null } };
}

// @ts-expect-error: this server sends binary. Register binary() in client().
client<Mixed>()(connect('wss://huddle.example.com/huddle'));
client<Mixed>()(connect('wss://huddle.example.com/huddle'), binary());

interface MixedChannel {
  [key: string]: unknown;
  channels: { rooms: { binary: { incoming: { 'screen-frame': { from: string } } } } };
}

// @ts-expect-error: a channel's binary entries need binary() too
client<MixedChannel>()(connect('wss://huddle.example.com/huddle'), channels());

// An empty `binary` has no entries, so it does not ask for binary().
client<{ incoming: { 'avatar-saved': { userId: string } }; binary: {} }>()(
  connect('wss://huddle.example.com/huddle'),
);

// A channel map with an index signature is checked through its value type.
interface AnyRoomBinary {
  channels: Record<string, { binary: { incoming: { 'screen-frame': { from: string } } } }>;
}

// @ts-expect-error: a channel's binary entries need binary() too
client<AnyRoomBinary>()(connect('wss://huddle.example.com/huddle'), channels());
client<AnyRoomBinary>()(connect('wss://huddle.example.com/huddle'), channels(), binary());
// oxlint-disable-next-line @typescript-eslint/no-explicit-any -- the loose channel map under test
client<{ channels: Record<string, any> }>()(connect('wss://huddle.example.com/huddle'), channels());
client<{ channels: Record<string, ScopeContract> }>()(
  connect('wss://huddle.example.com/huddle'),
  channels(),
);

// An upload belongs to no channel, so a channel contract cannot declare uploads.
interface ChannelUploads {
  channels: {
    rooms: { binary: { uploads: { 'share-file': { payload: { name: string }; response: null } } } };
  };
}

// @ts-expect-error: uploads are not channel events
client<ChannelUploads>();

// Without binary entries, binary() adds no `.binary`, and nothing asks for binary().
interface NoBinary {
  incoming: { 'avatar-saved': { userId: string } };
}

const plain = client<NoBinary>()(connect('wss://huddle.example.com/huddle'));
// @ts-expect-error: no binary entries, so no `.binary`
plain.binary;
// @ts-expect-error: no binary entries, so no `.binary` even with binary()
client<NoBinary>()(connect('wss://huddle.example.com/huddle'), binary()).binary;

// A receive-only scope has `on` but no `send`, and the other way round.
interface ReceiveOnly {
  binary: { incoming: { 'avatar-preview': null } };
}

const receiver = client<ReceiveOnly>()(connect('wss://huddle.example.com/huddle'), binary());
receiver.binary.on('avatar-preview', () => {});
// @ts-expect-error: nothing to send
receiver.binary.send;

// Plugins: the scoped socket gets `.binary` with plain names, and the app socket does not
// see a claimed plugin's prefixed names.
interface ScreensWire {
  binary: {
    incoming: { 'screen-frame': { from: string } };
    outgoing: { 'share-screen-frame': null };
  };
  channels: {
    stage: {
      binary: { incoming: { 'stage-frame': null }; outgoing: { 'share-stage-frame': null } };
    };
  };
}

interface ScreensHost {
  binary: {
    incoming: { '__acme:screens::screen-frame': { from: string }; 'avatar-preview': null };
    outgoing: { '__acme:screens::share-screen-frame': null };
  };
  channels: {
    '__acme:screens::stage': {
      binary: { incoming: { 'stage-frame': null }; outgoing: { 'share-stage-frame': null } };
    };
  };
}

const Screens = plugin<ScreensWire>()({
  id: 'acme:screens',
  dependencies: [binary, channels],
  setup(scoped) {
    scoped.binary.on('screen-frame', (info, bytes) => {
      expectTypeOf(info).toEqualTypeOf<{ from: string }>();
      expectTypeOf(bytes).toEqualTypeOf<Uint8Array>();
    });
    scoped.binary.send('share-screen-frame', null, new Uint8Array(4));
    // @ts-expect-error: the plugin uses plain names
    scoped.binary.on('__acme:screens::screen-frame', () => {});
    scoped.channel('stage').binary.on('stage-frame', (info) => {
      expectTypeOf(info).toEqualTypeOf<null>();
    });
    scoped.channel('stage').binary.send('share-stage-frame', null);

    return {};
  },
});

const host = client<ScreensHost>()(
  connect('wss://huddle.example.com/huddle'),
  binary(),
  channels(),
  Screens(),
);
host.binary.on('avatar-preview', () => {});
// @ts-expect-error: a claimed plugin's binary names are reached through the plugin
host.binary.on('__acme:screens::screen-frame', () => {});

// A plugin that lists binary in its dependencies needs binary() in client().
// @ts-expect-error: plugin 'acme:screens' requires binary()
client<ScreensHost>()(connect('wss://huddle.example.com/huddle'), channels(), Screens());

// A plugin whose binary names are missing from the contract does not fit it.
interface WrongHost {
  binary: { incoming: { 'avatar-preview': null } };
  channels: ScreensHost['channels'];
}

// @ts-expect-error: the contract lacks the plugin's binary names
client<WrongHost>()(connect('wss://huddle.example.com/huddle'), binary(), channels(), Screens());

// A plugin's uploads must be in the contract too, under its prefix.
const Files = plugin<{
  binary: {
    uploads: { 'share-file': { payload: { name: string }; response: { fileId: string } } };
  };
}>()({ id: 'acme:files', dependencies: [binary], setup: () => ({}) });

client<{
  binary: {
    uploads: {
      '__acme:files::share-file': { payload: { name: string }; response: { fileId: string } };
    };
  };
}>()(connect('wss://huddle.example.com/huddle'), binary(), Files());
// @ts-expect-error: the contract lacks the plugin's upload
client<ReceiveOnly>()(connect('wss://huddle.example.com/huddle'), binary(), Files());

// Testing helpers are typed from the binary entries.
injectBinary(socket, 'avatar-cropped', { width: 64 }, picture);
injectBinary(socket, 'avatar-preview', null);
// @ts-expect-error: wrong info type
injectBinary(socket, 'avatar-cropped', { width: '64' });
// @ts-expect-error: a JSON event is not a binary event
injectBinary(socket, 'avatar-saved', { userId: 'u_amara' });
const generalRoom = { family: 'rooms', name: 'room:general' } as const;
injectChannelBinary(socket, generalRoom, 'screen-frame', { from: 'u_amara' }, picture);
// @ts-expect-error: wrong info type on a channel
injectChannelBinary(socket, generalRoom, 'screen-frame', null);
// @ts-expect-error: a dynamic family needs { family, name }; the family name alone reaches no handle
injectChannelBinary(socket, 'rooms', 'screen-frame', { from: 'u_amara' }, picture);
// @ts-expect-error: 'avatar-preview' is not a binary event of the rooms channel
injectChannelBinary(socket, generalRoom, 'avatar-preview', null);

interface WithLobby {
  channels: { lobby: { binary: { incoming: { 'screen-frame': { from: string } } } } };
}

declare const lobbySocket: Socket<WithLobby>;
injectChannelBinary(lobbySocket, 'lobby', 'screen-frame', { from: 'u_amara' });
// @ts-expect-error: a fixed channel is named by its name, not by { family, name }
injectChannelBinary(lobbySocket, { family: 'lobby', name: 'lobby' }, 'screen-frame', {
  from: 'u_amara',
});
