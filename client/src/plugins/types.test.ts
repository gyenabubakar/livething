/* oxlint-disable @typescript-eslint/no-explicit-any -- type test file uses `any` for casting in type assertions */
/**
 * Type-level tests for the plugin type system.
 *
 * This file never runs — it's checked by `tsc --noEmit`. If any assertion
 * fails, the typecheck script (and commit hooks) catch it.
 *
 * - Plain assignments = "this should compile"
 * - @ts-expect-error = "this should NOT compile"
 *
 * Each section explains what's being tested and why.
 */

import { Plugin } from '~/plugins/base.ts';
import type {
  Apply,
  ApplyPlugins,
  SocketWithPlugins,
  TypeFn,
  ValidatePlugins,
} from '~/plugins/types.ts';
import type {
  IncomingMethod,
  IncomingOf,
  OutgoingMethod,
  OutgoingOf,
  RequestMethod,
  Requires,
  ScopedApi,
  ScopedEndpoint,
  SocketContract,
  StaticApi,
} from '~/types.ts';

// ===========================================================================
// Test contracts
// ===========================================================================

// A full contract with everything defined.
interface FullContract extends SocketContract {
  incoming: {
    notification: { id: string; title: string };
    'user-online': { userId: string };
  };
  outgoing: {
    'mark-read': { notificationId: string };
    typing: { channelId: string };
  };
  channels: {
    chat: {
      incoming: { message: { text: string; from: string } };
      outgoing: { 'send-message': { text: string } };
      requests: {
        'get-history': {
          payload: { before: string };
          response: { messages: { text: string }[] };
        };
      };
    };
    alerts: {
      incoming: { alert: { level: string } };
    };
  };
  requests: {
    'get-balance': {
      payload: { userId: string };
      response: { balance: number };
    };
  };
}

// A minimal contract with only incoming events.
interface MinimalContract extends SocketContract {
  incoming: {
    ping: {};
  };
}

// ===========================================================================
// 1. TypeFn + Apply basics
// ===========================================================================

// A type function that reads `outgoing` from the contract and adds a
// `broadcast` method typed against those events.
interface BroadcastTypeFn extends TypeFn {
  readonly _api: this['_contract'] extends { outgoing: infer O }
    ? { broadcast<K extends keyof O>(event: K, payload: O[K]): void }
    : {};
}

// Apply with a contract that has outgoing → broadcast method appears
type BroadcastApi = Apply<BroadcastTypeFn, FullContract>;
const _broadcastTest: BroadcastApi = {} as any;
// event is constrained to 'mark-read' | 'typing'
_broadcastTest.broadcast('mark-read', { notificationId: '123' });
_broadcastTest.broadcast('typing', { channelId: '456' });

// @ts-expect-error — 'foo' is not in outgoing
_broadcastTest.broadcast('foo', {});

// @ts-expect-error — wrong payload shape for 'mark-read'
_broadcastTest.broadcast('mark-read', { wrong: true });

// Apply with a contract that has NO outgoing → empty object, no broadcast
type NoBroadcast = Apply<BroadcastTypeFn, MinimalContract>;
const _noBroadcastTest: NoBroadcast = {} as any;
// @ts-expect-error — broadcast doesn't exist because MinimalContract has no outgoing
_noBroadcastTest.broadcast;

// ===========================================================================
// 2. StaticApi — for plugins with fixed APIs
// ===========================================================================

// StaticApi wraps a fixed shape. The contract is ignored.
type MetricsApi = Apply<StaticApi<{ getCount(event: string): number }>, FullContract>;
const _metricsTest: MetricsApi = {} as any;
_metricsTest.getCount('notification'); // works

// Same API regardless of contract
type MetricsApi2 = Apply<StaticApi<{ getCount(event: string): number }>, MinimalContract>;
const _metricsTest2: MetricsApi2 = {} as any;
_metricsTest2.getCount('anything'); // still works

// ===========================================================================
// 3. Plugin class — carrying type functions as phantom types
// ===========================================================================

// A concrete plugin with a static API
class MetricsPlugin extends Plugin<StaticApi<{ getCount(event: string): number }>> {
  id = 'metrics';
  getCount(_event: string): number {
    return 0;
  }
}

// A concrete plugin with a contract-dependent API
interface TestChannelsTypeFn extends TypeFn {
  readonly _api: this['_contract'] extends { channels: infer C }
    ? { channel<K extends keyof C>(name: K): C[K] }
    : {};
}

class TestChannelsPlugin extends Plugin<TestChannelsTypeFn, { channels: Record<string, any> }> {
  id = 'channels';
}

// ===========================================================================
// 4. ApplyPlugins — merging multiple plugins
// ===========================================================================

// Two plugins merged: MetricsPlugin (static) + TestChannelsPlugin (contract-dependent)
type Merged = ApplyPlugins<[MetricsPlugin, TestChannelsPlugin], FullContract>;
const _merged: Merged = {} as any;

// MetricsPlugin contributes getCount
_merged.getCount('test');

// TestChannelsPlugin contributes channel(), typed against FullContract's channels
_merged.channel('chat');
_merged.channel('alerts');

// @ts-expect-error — 'billing' is not a channel in FullContract
_merged.channel('billing');

// Empty plugin array → empty object
type NoPlugins = ApplyPlugins<[], FullContract>;
const _noPlugins: NoPlugins = {};
void _noPlugins; // just an empty object, nothing to call

// ===========================================================================
// 5. ValidatePlugins — catching missing contract requirements
// ===========================================================================

// TestChannelsPlugin requires { channels: Record<string, any> }.
// FullContract has channels → valid.
type ValidFull = ValidatePlugins<FullContract, [MetricsPlugin, TestChannelsPlugin]>;
// Both positions resolve to their plugin types (not `never`).
const _validFull: ValidFull = [new MetricsPlugin(), new TestChannelsPlugin()];
void _validFull;

// MinimalContract does NOT have channels → TestChannelsPlugin position becomes `never`.
type InvalidMinimal = ValidatePlugins<MinimalContract, [MetricsPlugin, TestChannelsPlugin]>;
// MetricsPlugin is fine (no requirements), TestChannelsPlugin is `never`.
// @ts-expect-error — can't assign TestChannelsPlugin to `never`
const _invalidMinimal: InvalidMinimal = [new MetricsPlugin(), new TestChannelsPlugin()];
void _invalidMinimal;

// ===========================================================================
// 6. SocketWithPlugins — the full picture
// ===========================================================================

// Simulating a base socket with send/on
interface FakeBaseSocket {
  send(event: string, payload: unknown): boolean;
  on(event: string, handler: (payload: unknown) => void): () => void;
  connect(): void;
  disconnect(code?: number, reason?: string): void;
}

type FinalSocket = SocketWithPlugins<
  FullContract,
  [MetricsPlugin, TestChannelsPlugin],
  FakeBaseSocket
>;

const _socket: FinalSocket = {} as any;

// Base methods work
_socket.send('test', {});
_socket.connect();
_socket.disconnect(4001, 'auth expired');

// Plugin methods work
_socket.getCount('notification');
_socket.channel('chat');

// @ts-expect-error — 'billing' is not a channel
_socket.channel('billing');

// ===========================================================================
// 7. Contract extractors
// ===========================================================================

type FullIncoming = IncomingOf<FullContract>;
const _incoming: FullIncoming = {} as any;
// Can access known incoming events
const _notif: { id: string; title: string } = _incoming.notification;
void _notif;

type FullOutgoing = OutgoingOf<FullContract>;
const _outgoing: FullOutgoing = {} as any;
const _markRead: { notificationId: string } = _outgoing['mark-read'];
void _markRead;

// Extractors on a contract missing the key → empty object
type NoOutgoing = OutgoingOf<MinimalContract>;
const _noOutgoing: NoOutgoing = {};
void _noOutgoing;

// ===========================================================================
// 8. Requires — building contract constraints
// ===========================================================================

type NeedsPresenceEvents = Requires<{
  incoming: ['user-joined', 'user-left'];
  outgoing: ['announce-presence'];
}>;

// A contract that satisfies the requirement
interface PresenceContract extends SocketContract {
  incoming: {
    'user-joined': { userId: string };
    'user-left': { userId: string };
  };
  outgoing: {
    'announce-presence': { status: string };
  };
}

// PresenceContract extends the requirement → true
type _CheckPresence = PresenceContract extends NeedsPresenceEvents ? true : false;
const _presenceOk: _CheckPresence = true;
void _presenceOk;

// MinimalContract does NOT satisfy → false
type _CheckMinimal = MinimalContract extends NeedsPresenceEvents ? true : false;
const _presenceFail: _CheckMinimal = false;
void _presenceFail;

// ===========================================================================
// 9. Edge cases
// ===========================================================================

// A plugin with no type function (just hooks) adds nothing to the socket
class HooksOnlyPlugin extends Plugin {
  id = 'hooks-only';
  onIncoming(msg: { event: string; payload: unknown }) {
    return msg;
  }
}

type HooksOnlyMerged = ApplyPlugins<[HooksOnlyPlugin], FullContract>;
// Should be an empty-ish object — the plugin declared no API
const _hooksOnly: HooksOnlyMerged = {} as any;
void _hooksOnly;

// ===========================================================================
// 10. OutgoingMethod — one-liner for outgoing-typed methods
// ===========================================================================

interface BroadcastTypeFn2 extends TypeFn {
  readonly _api: OutgoingMethod<this['_contract'], 'broadcast', void>;
}

type BroadcastApi2 = Apply<BroadcastTypeFn2, FullContract>;
const _broadcast2: BroadcastApi2 = {} as any;
_broadcast2.broadcast('mark-read', { notificationId: '123' });
_broadcast2.broadcast('typing', { channelId: '456' });
// @ts-expect-error — invalid event
_broadcast2.broadcast('foo', {});
// @ts-expect-error — wrong payload
_broadcast2.broadcast('mark-read', { wrong: true });

// Empty when contract has no outgoing
type NoBroadcast2 = Apply<BroadcastTypeFn2, MinimalContract>;
const _noBroadcast2: NoBroadcast2 = {};
void _noBroadcast2;

// ===========================================================================
// 11. IncomingMethod — one-liner for incoming-typed methods
// ===========================================================================

interface TapTypeFn extends TypeFn {
  readonly _api: IncomingMethod<this['_contract'], 'tap'>;
}

type TapApi = Apply<TapTypeFn, FullContract>;
const _tap: TapApi = {} as any;
const _unsub: () => void = _tap.tap('notification', (data) => {
  const _id: string = data.id;
  void _id;
});
void _unsub;
// @ts-expect-error — invalid event
_tap.tap('foo', () => {});

// Empty when contract has no incoming
interface NoIncomingContract extends SocketContract {
  outgoing: { ping: {} };
}
type NoTap = Apply<TapTypeFn, NoIncomingContract>;
const _noTap: NoTap = {};
void _noTap;

// ===========================================================================
// 12. RequestMethod — one-liner for request-typed methods
// ===========================================================================

interface QueryTypeFn extends TypeFn {
  readonly _api: RequestMethod<this['_contract'], 'query'>;
}

type QueryApi = Apply<QueryTypeFn, FullContract>;
const _query: QueryApi = {} as any;
const _balance: Promise<{ balance: number }> = _query.query('get-balance', { userId: '1' });
void _balance;
// @ts-expect-error — invalid request
_query.query('foo', {});
// @ts-expect-error — wrong payload
_query.query('get-balance', { wrong: true });

// Empty when contract has no requests
type NoQuery = Apply<QueryTypeFn, MinimalContract>;
const _noQuery: NoQuery = {};
void _noQuery;

// ===========================================================================
// 13. ScopedEndpoint — full endpoint for scoped contracts
// ===========================================================================

// Chat channel has incoming, outgoing, and requests
type ChatEndpoint = ScopedEndpoint<FullContract['channels']['chat']>;
const _chat: ChatEndpoint = {} as any;

// on() typed against channel incoming
_chat.on('message', (data) => {
  const _text: string = data.text;
  void _text;
});
// @ts-expect-error — invalid event for this channel
_chat.on('alert', () => {});

// send() typed against channel outgoing
_chat.send('send-message', { text: 'hi' });
// @ts-expect-error — invalid event
_chat.send('foo', {});

// request() present because chat has requests
const _history: Promise<{ messages: { text: string }[] }> = _chat.request('get-history', {
  before: '123',
});
void _history;
// @ts-expect-error — invalid request
_chat.request('foo', {});

// send.withAck() present because chat has outgoing
_chat.send.withAck('send-message', { text: 'hi' });

// Alerts channel: incoming only — no send, no request, no withAck
type AlertsEndpoint = ScopedEndpoint<FullContract['channels']['alerts']>;
const _alerts: AlertsEndpoint = {} as any;
_alerts.on('alert', (data) => {
  const _level: string = data.level;
  void _level;
});
// @ts-expect-error — no send on incoming-only channel
_alerts.send;
// @ts-expect-error — no request on channel without requests
_alerts.request;

// ===========================================================================
// 14. ScopedApi — one-liner for scoped plugins
// ===========================================================================

// Channels plugin TypeFn using ScopedApi
interface TestScopedChannelsTypeFn extends TypeFn {
  readonly _api: ScopedApi<this['_contract'], 'channels', 'channel'>;
}

type ScopedChannelsApi = Apply<TestScopedChannelsTypeFn, FullContract>;
const _scopedChannels: ScopedChannelsApi = {} as any;

// channel() returns ScopedEndpoint for the named channel
const _chatEp = _scopedChannels.channel('chat');
_chatEp.on('message', (data) => {
  const _from: string = data.from;
  void _from;
});
_chatEp.send('send-message', { text: 'hello' });
_chatEp.request('get-history', { before: '123' });

// @ts-expect-error — invalid channel name
_scopedChannels.channel('nonexistent');

// Empty when contract has no channels
type NoScopedChannels = Apply<TestScopedChannelsTypeFn, MinimalContract>;
const _noScopedChannels: NoScopedChannels = {};
void _noScopedChannels;

// Custom scoped plugin (Rooms) — same one-liner pattern
interface RoomsTypeFn extends TypeFn {
  readonly _api: ScopedApi<this['_contract'], 'rooms', 'room'>;
}

interface RoomContract extends SocketContract {
  rooms: {
    lobby: {
      incoming: { 'user-joined': { name: string } };
      outgoing: { chat: { text: string } };
      requests: {
        'get-members': { payload: {}; response: { members: string[] } };
      };
    };
  };
}

type RoomsApi = Apply<RoomsTypeFn, RoomContract>;
const _rooms: RoomsApi = {} as any;
const _lobby = _rooms.room('lobby');
_lobby.on('user-joined', (data) => {
  const _name: string = data.name;
  void _name;
});
_lobby.send('chat', { text: 'hi' });
const _members: Promise<{ members: string[] }> = _lobby.request('get-members', {});
void _members;

// ===========================================================================
// 15. Dynamic channels — index signature contracts
// ===========================================================================

// A contract where any string is a valid channel name (index signature)
interface DynamicChannelContract extends SocketContract {
  incoming: { status: { online: boolean } };
  channels: {
    [roomName: string]: {
      incoming: {
        message: { text: string; from: string };
        typing: { userId: string };
      };
      outgoing: {
        'send-message': { text: string };
      };
      requests: {
        'get-history': {
          payload: { limit: number };
          response: { messages: string[] };
        };
      };
    };
  };
}

// ScopedApi with index signature → channel() accepts any string
type DynamicChannelsApi = Apply<TestScopedChannelsTypeFn, DynamicChannelContract>;
const _dynamicChannels: DynamicChannelsApi = {} as any;

// Any string name is valid — these all compile
const _room1 = _dynamicChannels.channel('general');
void _dynamicChannels.channel('random');
void _dynamicChannels.channel('any-runtime-string');

// Variable name works — the key type is `string`
const roomName = 'computed-at-runtime' as string;
void _dynamicChannels.channel(roomName);

// Endpoints have correct types
_room1.on('message', (data) => {
  const _text: string = data.text;
  const _from: string = data.from;
  void _text;
  void _from;
});
_room1.on('typing', (data) => {
  const _userId: string = data.userId;
  void _userId;
});
_room1.send('send-message', { text: 'hi' });

// @ts-expect-error — invalid event for this channel shape
_room1.on('nonexistent', () => {});
// @ts-expect-error — invalid outgoing event
_room1.send('foo', {});
// @ts-expect-error — wrong payload shape
_room1.send('send-message', { wrong: true });

// request() works on dynamic channels
const _dynamicHistory: Promise<{ messages: string[] }> = _room1.request('get-history', {
  limit: 10,
});
void _dynamicHistory;
// @ts-expect-error — invalid request
_room1.request('foo', {});
// @ts-expect-error — wrong payload
_room1.request('get-history', { wrong: true });

// send.withAck() works on dynamic channels
_room1.send.withAck('send-message', { text: 'hi' });
// @ts-expect-error — invalid event for withAck
_room1.send.withAck('foo', {});

// ScopedEndpoint for a dynamic channel entry
type DynamicRoomEndpoint = ScopedEndpoint<DynamicChannelContract['channels'][string]>;
const _dynEp: DynamicRoomEndpoint = {} as any;
_dynEp.on('message', (data) => {
  const _t: string = data.text;
  void _t;
});
_dynEp.send('send-message', { text: 'x' });
_dynEp.request('get-history', { limit: 5 });
_dynEp.send.withAck('send-message', { text: 'y' });

// ===========================================================================
// 16. Composing utilities — multiple methods from one TypeFn
// ===========================================================================

interface ComposedTypeFn extends TypeFn {
  readonly _api: OutgoingMethod<this['_contract'], 'broadcast', void> &
    RequestMethod<this['_contract'], 'query'>;
}

type ComposedApi = Apply<ComposedTypeFn, FullContract>;
const _composed: ComposedApi = {} as any;
_composed.broadcast('mark-read', { notificationId: '1' });
_composed.query('get-balance', { userId: '1' });

// ===========================================================================
// 17. ScopedEndpoint — onStream() for scoped contracts
// ===========================================================================

// --- 17a. Static channel with incoming: onStream() exists ---
type ChatOnStreamEndpoint = ScopedEndpoint<FullContract['channels']['chat']>;
const _chatStream: ChatOnStreamEndpoint = {} as any;

// onStream() returns an unsubscribe function
const _streamUnsub: () => void = _chatStream.onStream('message', {
  onChunk: (chunk, streamId) => {
    const _text: string = chunk.text;
    const _from: string = chunk.from;
    const _sid: string = streamId;
    void _text;
    void _from;
    void _sid;
  },
  onEnd: (streamId) => {
    const _sid: string = streamId;
    void _sid;
  },
  onTimeout: (streamId) => {
    const _sid: string = streamId;
    void _sid;
  },
});
void _streamUnsub;

// --- 17b. Static channel without incoming: onStream() does not exist ---
interface OutgoingOnlyChannelContract extends SocketContract {
  channels: {
    firehose: {
      outgoing: { emit: { value: number } };
    };
  };
}
type FirehoseEndpoint = ScopedEndpoint<OutgoingOnlyChannelContract['channels']['firehose']>;
const _firehose: FirehoseEndpoint = {} as any;
_firehose.send('emit', { value: 42 });
// @ts-expect-error — no onStream on channel without incoming
_firehose.onStream;

// --- 17c. Dynamic channels: onStream() exists ---
const _dynStreamRoom = _dynamicChannels.channel('any-name');
const _dynStreamUnsub: () => void = _dynStreamRoom.onStream('message', {
  onChunk: (chunk) => {
    const _text: string = chunk.text;
    const _from: string = chunk.from;
    void _text;
    void _from;
  },
});
void _dynStreamUnsub;

// --- 17d. onStream with wrong event name is a type error ---
// @ts-expect-error — 'nonexistent' is not an incoming event on chat
_chatStream.onStream('nonexistent', { onChunk: () => {} });

// --- 17e. onStream with wrong chunk type is a type error ---
_chatStream.onStream('message', {
  // @ts-expect-error — chunk is { text: string; from: string }, not { wrong: true }
  onChunk: (chunk: { wrong: true }) => {
    void chunk;
  },
});

// --- 17f. Alerts channel (incoming only): onStream exists, send.withAck doesn't ---
const _alertsStream: AlertsEndpoint = {} as any;
const _alertStreamUnsub: () => void = _alertsStream.onStream('alert', {
  onChunk: (chunk) => {
    const _level: string = chunk.level;
    void _level;
  },
});
void _alertStreamUnsub;
// @ts-expect-error — no send on incoming-only channel, so no send.withAck
_alertsStream.send;
