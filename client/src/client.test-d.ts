/* oxlint-disable @typescript-eslint/no-explicit-any -- type test file uses `any` for assertions */
// Type-only checks for the client API against a contract shaped exactly like
// what `@wskit/server`'s `InferClient` produces. tsc checks these; vitest never
// runs them. A broken assumption shows up as a build error.
import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { channels } from '~/primitives/channels/index.ts';
import { requestResponse } from '~/primitives/request-response/index.ts';
import { serverRequest } from '~/primitives/server-request/index.ts';
import { stream } from '~/primitives/stream/index.ts';
import { expectTypeOf } from 'vitest';
import type { EmptyTypeFn, Primitive, TypeFn } from '~/primitives/types.ts';
import type { StreamHandle } from '~/types.ts';

interface Full {
  incoming: { 'server-push': { value: number } };
  outgoing: { 'client-send': { text: string } };
  requests: { 'do-request': { payload: { id: string }; response: { ok: boolean } } };
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
    resumable: { payload: {}; chunk: { row: number }; kind: 'persistent'; cursor: { idx: number } };
    recorded: { payload: {}; chunk: { token: string }; kind: 'persistent' };
  };
  channels: {
    room: {
      incoming: { 'ch-push': { value: number } };
      outgoing: { 'ch-send': { text: string } };
      requests: { 'ch-request': { payload: { id: string }; response: { ok: boolean } } };
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
  requestResponse(),
  serverRequest(),
  stream(),
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

expectTypeOf(socket.resumeStream('resumable', 'id')).toEqualTypeOf<
  StreamHandle<{ row: number }, {}>
>();
socket.resumeStream('recorded', 'id');
// @ts-expect-error — 'plain-stream' is ephemeral, not resumable
socket.resumeStream('plain-stream', 'id');
// @ts-expect-error — 'nudged-stream' is ephemeral, not resumable
socket.resumeStream('nudged-stream', 'id');

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

expectTypeOf(socket.getState()).toBeString();
expectTypeOf(socket.connect()).toEqualTypeOf<void>();

const bare = client<Full>()(connect('wss://example.com'));
// @ts-expect-error — socket.channel needs the channels() primitive
bare.channel('room');
// @ts-expect-error — socket.request needs the requestResponse() primitive
bare.request('do-request', { id: '1' });
// @ts-expect-error — socket.onRequest needs the serverRequest() primitive
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
// @ts-expect-error — channel.request needs the requestResponse() primitive
onlyRoom.request('ch-request', { id: '1' });
// @ts-expect-error — channel.onRequest needs the serverRequest() primitive
onlyRoom.onRequest('ch-ask', () => ({ ok: true }));
// @ts-expect-error — channel.onStream needs the stream() primitive
onlyRoom.onStream('ch-stream', { onChunk: () => {} });
// @ts-expect-error — channel.stream needs the stream() primitive
onlyRoom.stream('ch-stream', {});
// @ts-expect-error — channel.resumeStream needs the stream() primitive
onlyRoom.resumeStream('ch-stream', 'id');

const channelsAndReq = client<Full>()(connect('wss://example.com'), channels(), requestResponse());
expectTypeOf(
  channelsAndReq.channel('room').request('ch-request', { id: '1' }),
).resolves.toEqualTypeOf<{ ok: boolean }>();
// @ts-expect-error — channel.onStream still needs the stream() primitive
channelsAndReq.channel('room').onStream('ch-stream', { onChunk: () => {} });

const everything = client<Full>()(
  connect('wss://example.com'),
  channels(),
  requestResponse(),
  serverRequest(),
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
