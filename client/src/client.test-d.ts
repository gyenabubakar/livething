/* oxlint-disable @typescript-eslint/no-explicit-any -- type test file uses `any` for assertions */
// Type-only checks for the client API against a contract shaped exactly like
// what `@livething/server`'s `InferClient` produces. tsc checks these; vitest never
// runs them. A broken assumption shows up as a build error.
import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { channels } from '~/primitives/channels/index.ts';
import { clientRequests } from '~/primitives/client-requests/index.ts';
import { dedup } from '~/primitives/dedup.ts';
import { gaps } from '~/primitives/gaps.ts';
import { inbox } from '~/primitives/inbox/inbox.ts';
import { readReceipts } from '~/primitives/inbox/read-receipts.ts';
import { replay } from '~/primitives/replay.ts';
import { serverRequests } from '~/primitives/server-requests/index.ts';
import { stream } from '~/primitives/stream/index.ts';
import { expectTypeOf } from 'vitest';
// `GapInfo` must be importable from the package root so a consumer can annotate
// an `onGap` handler from the same place as every other public type.
import type { GapInfo as GapInfoFromIndex, GapsTypeFn as GapsTypeFnFromIndex } from '~/index.ts';
import type { EmptyTypeFn, Primitive, PrimitiveIdentity, TypeFn } from '~/primitives/types.ts';
import type { GapInfo, StreamHandle } from '~/types.ts';

interface Full {
  incoming: { 'server-push': { value: number } };
  outgoing: { 'client-send': { text: string } };
  clientRequests: { 'do-request': { payload: { id: string }; response: { ok: boolean } } };
  serverRequests: {
    'ask-permission': { payload: { action: string }; response: { allowed: boolean } };
  };
  streams: {
    'plain-stream': { payload: {}; chunk: { idx: number }; kind: 'ephemeral' };
    'nudged-stream': {
      payload: {};
      chunk: { idx: number };
      kind: 'ephemeral';
      nudges: { stop: { now: boolean } };
    };
    durable: { payload: {}; chunk: { row: number }; kind: 'persistent' };
    recorded: { payload: {}; chunk: { token: string }; kind: 'persistent' };
  };
  channels: {
    room: {
      incoming: { 'ch-push': { value: number } };
      outgoing: { 'ch-send': { text: string } };
      clientRequests: { 'ch-request': { payload: { id: string }; response: { ok: boolean } } };
      serverRequests: {
        'ch-ask': { payload: { who: string }; response: { ok: boolean } };
      };
      streams: { 'ch-stream': { payload: {}; chunk: { idx: number }; kind: 'ephemeral' } };
      subscribePayload: { token: string };
    };
  };
  errors: { 'app-error': { reason: string } };
}

const socket = client<Full>()(
  connect('wss://example.com'),
  channels(),
  clientRequests(),
  serverRequests(),
  stream(),
  gaps(),
);

socket.on('server-push', (data) => {
  expectTypeOf(data).toEqualTypeOf<{ value: number }>();
});
// @ts-expect-error — 'nope' is not an incoming event
socket.on('nope', () => {});

expectTypeOf(socket.send('client-send', { text: 'hi' })).toEqualTypeOf<boolean>();
// @ts-expect-error — wrong payload shape
socket.send('client-send', { text: 1 });
// @ts-expect-error — 'nope' is not an outgoing event
socket.send('nope', {});

expectTypeOf(socket.request('do-request', { id: '1' })).resolves.toEqualTypeOf<{ ok: boolean }>();
// @ts-expect-error — wrong request payload
socket.request('do-request', { id: 1 });
// @ts-expect-error — 'nope' is not a request
socket.request('nope', {});

expectTypeOf(
  socket.onRequest('ask-permission', (payload) => {
    expectTypeOf(payload).toEqualTypeOf<{ action: string }>();
    return { allowed: true };
  }),
).toEqualTypeOf<() => void>();
socket.onRequest('ask-permission', async () => ({ allowed: false }));
// @ts-expect-error — wrong answer shape for 'ask-permission'
socket.onRequest('ask-permission', () => ({ allowed: 'yes' }));
// @ts-expect-error — 'nope' is not a server→client request
socket.onRequest('nope', () => ({}));

expectTypeOf(socket.stream('plain-stream', {})).resolves.toEqualTypeOf<
  StreamHandle<{ idx: number }, {}>
>();
socket.onStream('plain-stream', {
  onChunk(chunk, streamId) {
    expectTypeOf(chunk).toEqualTypeOf<{ idx: number }>();
    expectTypeOf(streamId).toEqualTypeOf<string>();
  },
});
// @ts-expect-error — wrong trigger payload type ('plain-stream' has chunk { idx }, payload {})
socket.onStream('plain-stream', { onChunk: (chunk: { wrong: true }) => void chunk });
// @ts-expect-error — 'nope' is not a declared stream
socket.onStream('nope', { onChunk: () => {} });

const nudgedTrigger = socket.stream('nudged-stream', {});
void nudgedTrigger.then((handle) => {
  expectTypeOf(handle.nudge('stop', { now: true })).resolves.toEqualTypeOf<void>();
  // @ts-expect-error — 'go' is not a declared nudge for this stream
  handle.nudge('go', {});
});

expectTypeOf(socket.continueStream('durable', 'id')).toEqualTypeOf<
  StreamHandle<{ row: number }, {}>
>();
socket.continueStream('recorded', 'id');
// @ts-expect-error — 'plain-stream' is ephemeral, not durable
socket.continueStream('plain-stream', 'id');
// @ts-expect-error — 'nudged-stream' is ephemeral, not durable
socket.continueStream('nudged-stream', 'id');

const room = socket.channel('room');
room.on('ch-push', (data) => expectTypeOf(data).toEqualTypeOf<{ value: number }>());
expectTypeOf(room.send('ch-send', { text: 'hi' })).toEqualTypeOf<boolean>();
// @ts-expect-error — 'ch-push' is an incoming event, not sendable
room.send('ch-push', { value: 1 });
expectTypeOf(room.request('ch-request', { id: '1' })).resolves.toEqualTypeOf<{ ok: boolean }>();
expectTypeOf(
  room.onRequest('ch-ask', (payload) => {
    expectTypeOf(payload).toEqualTypeOf<{ who: string }>();
    return { ok: true };
  }),
).toEqualTypeOf<() => void>();
room.onStream('ch-stream', { onChunk: (c) => expectTypeOf(c).toEqualTypeOf<{ idx: number }>() });

expectTypeOf(room.subscribe({ token: 't' })).resolves.toEqualTypeOf<void>();
// @ts-expect-error — subscribe payload is typed; a number is wrong
room.subscribe({ token: 1 });
// @ts-expect-error — subscribe payload is required for a checked channel
room.subscribe();
// @ts-expect-error — 'nope' is not a channel
socket.channel('nope');

room.onGap((info) => {
  expectTypeOf(info).toEqualTypeOf<GapInfo>();
});
socket.onGap((info) => {
  expectTypeOf(info).toEqualTypeOf<GapInfo>();
});
expectTypeOf<GapInfoFromIndex>().toEqualTypeOf<GapInfo>();
expectTypeOf<GapsTypeFnFromIndex>().toHaveProperty('_api');

expectTypeOf(socket.state.get()).toBeString();
expectTypeOf(socket.connect()).toEqualTypeOf<void>();

const bare = client<Full>()(connect('wss://example.com'));
// @ts-expect-error — socket.channel needs the channels() primitive
bare.channel('room');
// @ts-expect-error — socket.request needs the clientRequests() primitive
bare.request('do-request', { id: '1' });
// @ts-expect-error — socket.onRequest needs the serverRequests() primitive
bare.onRequest('ask-permission', () => ({ allowed: true }));
// @ts-expect-error — socket.onStream needs the stream() primitive
bare.onStream('plain-stream', { onChunk: () => {} });

const partial = client<Full>()(connect('wss://example.com'), stream());
partial.onStream('plain-stream', {
  onChunk: (c) => expectTypeOf(c).toEqualTypeOf<{ idx: number }>(),
});
// @ts-expect-error — channels() still missing
partial.channel('room');

const channelsOnly = client<Full>()(connect('wss://example.com'), channels());
const onlyRoom = channelsOnly.channel('room');
expectTypeOf(onlyRoom.subscribe({ token: 't' })).resolves.toEqualTypeOf<void>();
onlyRoom.on('ch-push', (data) => expectTypeOf(data).toEqualTypeOf<{ value: number }>());
onlyRoom.onSubscribed(() => {});
// @ts-expect-error — channel.onGap needs the gaps() primitive
onlyRoom.onGap(() => {});
// @ts-expect-error — channel.request needs the clientRequests() primitive
onlyRoom.request('ch-request', { id: '1' });
// @ts-expect-error — channel.onRequest needs the serverRequests() primitive
onlyRoom.onRequest('ch-ask', () => ({ ok: true }));
// @ts-expect-error — channel.onStream needs the stream() primitive
onlyRoom.onStream('ch-stream', { onChunk: () => {} });
// @ts-expect-error — channel.stream needs the stream() primitive
onlyRoom.stream('ch-stream', {});
// @ts-expect-error — channel.continueStream needs the stream() primitive
onlyRoom.continueStream('ch-stream', 'id');

const replayOnly = client<Full>()(connect('wss://example.com'), dedup(), replay());
// @ts-expect-error — replay() tracks cursors; gaps() owns the listener API
replayOnly.onGap(() => {});

const channelsAndReq = client<Full>()(connect('wss://example.com'), channels(), clientRequests());
expectTypeOf(
  channelsAndReq.channel('room').request('ch-request', { id: '1' }),
).resolves.toEqualTypeOf<{ ok: boolean }>();
// @ts-expect-error — channel.onStream still needs the stream() primitive
channelsAndReq.channel('room').onStream('ch-stream', { onChunk: () => {} });

const everything = client<Full>()(
  connect('wss://example.com'),
  channels(),
  clientRequests(),
  serverRequests(),
  stream(),
);
everything.channel('room').request('ch-request', { id: '1' });
everything.channel('room').onRequest('ch-ask', () => ({ ok: true }));
everything.channel('room').onStream('ch-stream', { onChunk: () => {} });

interface ReceiveOnly {
  incoming: { tick: { n: number } };
}

const recv = client<ReceiveOnly>()(connect('wss://example.com'));
recv.on('tick', (data) => expectTypeOf(data).toEqualTypeOf<{ n: number }>());
// @ts-expect-error — no outgoing, so send() is missing
recv.send;

interface PingApiTypeFn extends TypeFn {
  readonly _api: { ping(): number };
}

function pingPrimitive(): Primitive<PingApiTypeFn> {
  return { _tag: 'ping-test' };
}

const withApi = client<ReceiveOnly>()(connect('wss://example.com'), pingPrimitive());
expectTypeOf(withApi.ping()).toBeNumber();

function noop(): Primitive<EmptyTypeFn> {
  return { _tag: 'noop-test' };
}

const plain = client<ReceiveOnly>()(connect('wss://example.com'), noop());
// @ts-expect-error — noop adds no methods
plain.ping;

function needsChannels(): Primitive<EmptyTypeFn, { channels: Record<string, any> }> {
  return { _tag: 'needs-channels' };
}

// @ts-expect-error — ReceiveOnly has no `channels`
client<ReceiveOnly>()(connect('wss://example.com'), needsChannels());

interface Receipts {
  channels: {
    room: {
      incoming: { msg: { text: string } };
      inbox: true;
      readReceipts: true;
    };
    plain: {
      incoming: { msg: { text: string } };
    };
  };
}

const noReceiptPrimitives = client<Receipts>()(connect('wss://example.com'), dedup(), channels());
const noReceiptRoom = noReceiptPrimitives.channel('room');
// @ts-expect-error — receivers needs the inbox() primitive
noReceiptRoom.receivers;
// @ts-expect-error — onReceived needs the inbox() primitive
noReceiptRoom.onReceived;
// @ts-expect-error — receiversOf needs the inbox() primitive
noReceiptRoom.receiversOf;
// @ts-expect-error — readers needs the readReceipts() primitive
noReceiptRoom.readers;
// @ts-expect-error — markAsRead needs the readReceipts() primitive
noReceiptRoom.markAsRead;

const withReceiptPrimitives = client<Receipts>()(
  connect('wss://example.com'),
  dedup(),
  channels(),
  inbox(),
  readReceipts(),
);
const receiptRoom = withReceiptPrimitives.channel('room');
expectTypeOf(receiptRoom.receivers.get()).toEqualTypeOf<ReadonlyMap<string, number>>();
receiptRoom.onReceived((identity, receivedThrough) => {
  expectTypeOf(identity).toBeString();
  expectTypeOf(receivedThrough).toBeNumber();
});
expectTypeOf(receiptRoom.receiversOf(3)).resolves.toEqualTypeOf<string[]>();
expectTypeOf(receiptRoom.readers.get()).toEqualTypeOf<ReadonlyMap<string, number>>();
receiptRoom.onRead((identity, readThrough) => {
  expectTypeOf(identity).toBeString();
  expectTypeOf(readThrough).toBeNumber();
});
expectTypeOf(receiptRoom.readersOf(3)).resolves.toEqualTypeOf<string[]>();
expectTypeOf(receiptRoom.markAsRead()).toEqualTypeOf<void>();

const plainRoom = withReceiptPrimitives.channel('plain');
// @ts-expect-error — 'plain' channel has no inbox flag, so receivers is absent
plainRoom.receivers;
// @ts-expect-error — 'plain' channel has no readReceipts flag, so markAsRead is absent
plainRoom.markAsRead;

// A channel can carry both an installed primitive's surface (inbox) and a
// section whose primitive is missing (clientRequests). Omitting clientRequests()
// must produce a clear stub error on `request` without erasing `receivers`.
interface MixedChannel {
  channels: {
    room: {
      incoming: { msg: { text: string } };
      inbox: true;
      clientRequests: { 'do-thing': { payload: { id: string }; response: { ok: boolean } } };
    };
  };
}

const mixed = client<MixedChannel>()(connect('wss://example.com'), channels(), dedup(), inbox());
const mixedRoom = mixed.channel('room');
expectTypeOf(mixedRoom.receivers.get()).toEqualTypeOf<ReadonlyMap<string, number>>();
mixedRoom.onReceived((identity, receivedThrough) => {
  expectTypeOf(identity).toBeString();
  expectTypeOf(receivedThrough).toBeNumber();
});
// @ts-expect-error — channel.request still needs the clientRequests() primitive
mixedRoom.request('do-thing', { id: '1' });

interface MixedFamily {
  channels: {
    rooms: {
      addressing: 'dynamic';
      incoming: { msg: { text: string } };
      inbox: true;
      clientRequests: { 'do-thing': { payload: { id: string }; response: { ok: boolean } } };
    };
  };
}

const mixedFamily = client<MixedFamily>()(
  connect('wss://example.com'),
  channels(),
  dedup(),
  inbox(),
);
const mixedFamilyMember = mixedFamily.channel('rooms', 'general');
expectTypeOf(mixedFamilyMember.receivers.get()).toEqualTypeOf<ReadonlyMap<string, number>>();
// @ts-expect-error — a family member's channel.request still needs clientRequests()
mixedFamilyMember.request('do-thing', { id: '1' });
const mixedFamilyHandle = mixedFamily.channel.family('rooms');
expectTypeOf(mixedFamilyHandle('general').receivers.get()).toEqualTypeOf<
  ReadonlyMap<string, number>
>();

// A primitive's dependencies are checked by the type, in any order, not only when client() runs.
// @ts-expect-error — replay() requires dedup()
client<Full>()(connect('wss://example.com'), replay());
// @ts-expect-error — inbox() requires dedup()
client<MixedChannel>()(connect('wss://example.com'), channels(), inbox());
client<Full>()(connect('wss://example.com'), replay(), dedup());
client<MixedChannel>()(connect('wss://example.com'), inbox(), channels(), dedup());

// A primitive typed as plain `Primitive` hides its tag, so the type can't tell which
// one it is. The check then steps aside and leaves this socket to the runtime check.
const wideDedup: Primitive<EmptyTypeFn> = dedup();
client<Full>()(connect('wss://example.com'), wideDedup, replay());
const widePrimitives: Primitive<EmptyTypeFn>[] = [dedup()];
client<Full>()(connect('wss://example.com'), ...widePrimitives, replay());

// A value typed as a union of primitives could be any of them, so the type can't
// tell what is registered. The check steps aside and the runtime check decides.
declare const replayOrDedup: ReturnType<typeof replay> | ReturnType<typeof dedup>;
client<Full>()(connect('wss://example.com'), replayOrDedup);

// A union reports a dependency only when every member of the union needs it.
declare const replayOrChannels: ReturnType<typeof replay> | ReturnType<typeof channels>;
client<MixedChannel>()(connect('wss://example.com'), channels(), replayOrChannels);
declare const replayOrInbox: ReturnType<typeof replay> | ReturnType<typeof inbox>;
// @ts-expect-error — replay() and inbox() both require dedup()
client<MixedChannel>()(connect('wss://example.com'), channels(), replayOrInbox);

// A primitive inside a spread that may be empty may not be registered at all, and then
// its dependency is not needed. Only a primitive certainly in the call is checked.
declare const useReplay: boolean;
declare const roomIds: string[];
client<Full>()(connect('wss://example.com'), ...[replay()].filter(() => useReplay));
client<Full>()(connect('wss://example.com'), ...roomIds.map(() => replay()));
declare const gapsList: ReturnType<typeof gaps>[];
// @ts-expect-error — the replay() before the spread is certainly there, and requires dedup()
client<Full>()(connect('wss://example.com'), replay(), ...gapsList);
// TypeScript gives an item after a spread the same position type as the spread, so a
// replay() placed there can't be told apart from one inside it. It is left to the
// runtime check, which throws here.
client<Full>()(connect('wss://example.com'), ...gapsList, replay());

// Each built-in primitive has its own type, so a list that starts with one primitive
// holds only that kind. Typing the list as `Primitive[]` lets it hold any primitive.
const primitiveList: Primitive<EmptyTypeFn>[] = [dedup()];
primitiveList.push(replay());
client<Full>()(connect('wss://example.com'), ...primitiveList);

// connect() is always registered, so depending on it is never an error.
declare const needsConnect: Primitive<EmptyTypeFn> & PrimitiveIdentity<'needs-connect', 'connect'>;
client<Full>()(connect('wss://example.com'), needsConnect);
