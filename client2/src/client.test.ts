/* oxlint-disable @typescript-eslint/no-explicit-any -- type test file uses `any` for assertions */
// Type-only checks for client() and the primitive inference. tsc checks these;
// vitest never runs them. A broken assumption shows up as a build error.
import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import type { EmptyTypeFn, Primitive, TypeFn } from '~/primitives/types.ts';

interface FullContract {
  incoming: { notification: { id: string; title: string } };
  outgoing: { 'mark-read': { notificationId: string } };
  requests: { 'get-balance': { payload: { userId: string }; response: { balance: number } } };
}

interface ReceiveOnly {
  incoming: { tick: { n: number } };
}

// on() and send() are typed from the contract.
const socket = client<FullContract>()(connect('wss://example.com'));

socket.on('notification', (data) => {
  const _id: string = data.id;
  void _id;
});

// @ts-expect-error — 'nope' is not an incoming event
socket.on('nope', () => {});

const sent: boolean = socket.send('mark-read', { notificationId: '1' });
void sent;

// @ts-expect-error — wrong payload shape
socket.send('mark-read', { wrong: true });

// The connection methods are always there.
const _state: string = socket.getState();
void _state;
socket.connect();
socket.disconnect(4001, 'bye');

// With no outgoing in the contract, send() doesn't exist.
const recv = client<ReceiveOnly>()(connect('wss://example.com'));
recv.on('tick', (data) => {
  const _n: number = data.n;
  void _n;
});

// @ts-expect-error — no outgoing, so send() is missing
recv.send;

// A primitive's _typeFn adds methods to the socket.
interface PingApiTypeFn extends TypeFn {
  readonly _api: { ping(): number };
}

function pingPrimitive(): Primitive<PingApiTypeFn> {
  return { _tag: 'ping-test' };
}

const withApi = client<FullContract>()(connect('wss://example.com'), pingPrimitive());
const _pong: number = withApi.ping();
void _pong;

// The base API is still there next to the added one.
withApi.on('notification', () => {});

// A primitive with EmptyTypeFn adds nothing.
function noop(): Primitive<EmptyTypeFn> {
  return { _tag: 'noop-test' };
}
const plain = client<FullContract>()(connect('wss://example.com'), noop());
// @ts-expect-error — noop adds no methods
plain.ping;

// A primitive whose _requires isn't met is rejected right at the call.
function needsChannels(): Primitive<EmptyTypeFn, { channels: Record<string, any> }> {
  return { _tag: 'needs-channels' };
}

// @ts-expect-error — FullContract has no `channels`
client<FullContract>()(connect('wss://example.com'), needsChannels());
