/* oxlint-disable @typescript-eslint/no-explicit-any -- type test file uses `any` for assertions */
// Type-only checks for the client API against a contract shaped exactly like
// what `@wskit/server`'s `InferClient` produces. tsc checks these; vitest never
// runs them. A broken assumption shows up as a build error.
import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { ack } from '~/primitives/ack/index.ts';
import { channels } from '~/primitives/channels/index.ts';
import { requestResponse } from '~/primitives/request-response/index.ts';
import { stream } from '~/primitives/stream/index.ts';
import { expectTypeOf } from 'vitest';
import type { EmptyTypeFn, Primitive, TypeFn } from '~/primitives/types.ts';
import type { StreamHandle } from '~/types.ts';

// ───────────────────────────────────────────────────────────────────────────
// One contract covering every slot, in the exact shape `InferClient<typeof
// server>` returns: top-level incoming/outgoing/requests/streams, a channel
// (with `subscribePayload` from a server `check`), and errors. Stream
// entries carry `chunk` (singular), a `kind` discriminator, and — only when
// declared — `nudges`/`cursor`. This is the wire-faithful client contract.
// ───────────────────────────────────────────────────────────────────────────
interface Full {
  incoming: { 'server-push': { value: number } };
  outgoing: { 'client-send': { text: string } };
  requests: { 'do-request': { payload: { id: string }; response: { ok: boolean } } };
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
  ack(),
  stream(),
);

// ── top-level on() / send() ──────────────────────────────────────────────────
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

// ── request() (requestResponse) ──────────────────────────────────────────────
expectTypeOf(socket.request('do-request', { id: '1' })).resolves.toEqualTypeOf<{ ok: boolean }>();
// @ts-expect-error — wrong request payload
socket.request('do-request', { id: 1 });
// @ts-expect-error — 'nope' is not a request
socket.request('nope', {});

// ── sendWithAck() (ack) ──────────────────────────────────────────────────────
expectTypeOf(socket.sendWithAck('client-send', { text: 'hi' })).resolves.toEqualTypeOf<void>();
// @ts-expect-error — sendWithAck is typed from outgoing
socket.sendWithAck('server-push', { value: 1 });

// ── streams: stream() / onStream() / resumeStream() ──────────────────────────
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

// nudge() is typed from the stream's `nudges`.
const nudgedTrigger = socket.stream('nudged-stream', {});
void nudgedTrigger.then((handle) => {
  expectTypeOf(handle.nudge('stop', { now: true })).resolves.toEqualTypeOf<void>();
  // @ts-expect-error — 'go' is not a declared nudge for this stream
  handle.nudge('go', {});
});

// resumeStream() is gated to `kind: 'persistent'` streams.
expectTypeOf(socket.resumeStream('resumable', 'id')).toEqualTypeOf<
  StreamHandle<{ row: number }, {}>
>();
socket.resumeStream('recorded', 'id');
// @ts-expect-error — 'plain-stream' is ephemeral, not resumable
socket.resumeStream('plain-stream', 'id');
// @ts-expect-error — 'nudged-stream' is ephemeral, not resumable
socket.resumeStream('nudged-stream', 'id');

// ── channels: channel() + subscribe() typed from subscribePayload ────────────
const room = socket.channel('room');
room.on('ch-push', (data) => expectTypeOf(data).toEqualTypeOf<{ value: number }>());
expectTypeOf(room.send('ch-send', { text: 'hi' })).toEqualTypeOf<boolean>();
// @ts-expect-error — 'ch-push' is an incoming event, not sendable
room.send('ch-push', { value: 1 });
expectTypeOf(room.request('ch-request', { id: '1' })).resolves.toEqualTypeOf<{ ok: boolean }>();
room.onStream('ch-stream', { onChunk: (c) => expectTypeOf(c).toEqualTypeOf<{ idx: number }>() });

// subscribe() requires the typed payload when the channel declares one.
expectTypeOf(room.subscribe({ token: 't' })).resolves.toEqualTypeOf<void>();
// @ts-expect-error — subscribe payload is typed; a number is wrong
room.subscribe({ token: 1 });
// @ts-expect-error — subscribe payload is required for a checked channel
room.subscribe();
// @ts-expect-error — 'nope' is not a channel
socket.channel('nope');

// ── connection methods are always present ────────────────────────────────────
expectTypeOf(socket.getState()).toBeString();
expectTypeOf(socket.connect()).toEqualTypeOf<void>();

// ───────────────────────────────────────────────────────────────────────────
// Missing-primitive stubs: a contract that declares scoped sections but whose
// primitives aren't installed. The methods exist as non-callable stubs whose
// type names the fix.
// ───────────────────────────────────────────────────────────────────────────
const bare = client<Full>()(connect('wss://example.com'));
// @ts-expect-error — socket.channel needs the channels() primitive
bare.channel('room');
// @ts-expect-error — socket.request needs the requestResponse() primitive
bare.request('do-request', { id: '1' });
// @ts-expect-error — socket.onStream needs the stream() primitive
bare.onStream('plain-stream', { onChunk: () => {} });

// Partial install: stream() present, the rest missing — the installed one works.
const partial = client<Full>()(connect('wss://example.com'), stream());
partial.onStream('plain-stream', {
  onChunk: (c) => expectTypeOf(c).toEqualTypeOf<{ idx: number }>(),
});
// @ts-expect-error — channels() still missing
partial.channel('room');

// ───────────────────────────────────────────────────────────────────────────
// General type-machinery guards (small, contract-agnostic).
// ───────────────────────────────────────────────────────────────────────────

// With no `outgoing`, send() doesn't exist.
interface ReceiveOnly {
  incoming: { tick: { n: number } };
}
const recv = client<ReceiveOnly>()(connect('wss://example.com'));
recv.on('tick', (data) => expectTypeOf(data).toEqualTypeOf<{ n: number }>());
// @ts-expect-error — no outgoing, so send() is missing
recv.send;

// A primitive's _typeFn adds methods to the socket.
interface PingApiTypeFn extends TypeFn {
  readonly _api: { ping(): number };
}
function pingPrimitive(): Primitive<PingApiTypeFn> {
  return { _tag: 'ping-test' };
}
const withApi = client<ReceiveOnly>()(connect('wss://example.com'), pingPrimitive());
expectTypeOf(withApi.ping()).toBeNumber();

// A primitive with EmptyTypeFn adds nothing.
function noop(): Primitive<EmptyTypeFn> {
  return { _tag: 'noop-test' };
}
const plain = client<ReceiveOnly>()(connect('wss://example.com'), noop());
// @ts-expect-error — noop adds no methods
plain.ping;

// A primitive whose _requires isn't met by the contract is rejected at the call.
function needsChannels(): Primitive<EmptyTypeFn, { channels: Record<string, any> }> {
  return { _tag: 'needs-channels' };
}
// @ts-expect-error — ReceiveOnly has no `channels`
client<ReceiveOnly>()(connect('wss://example.com'), needsChannels());
