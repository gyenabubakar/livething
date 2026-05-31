/* oxlint-disable @typescript-eslint/no-explicit-any -- type test file uses `any` for assertions */
/**
 * Type-level tests for `client()` + the primitive inference engine.
 * Compiled by `tsc` (not run by vitest). Failures surface as build errors.
 */
import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import type { EmptyTypeFn, PrimitiveSpec, TypeFn } from '~/primitives/types.ts';

// ===========================================================================
// Contracts
// ===========================================================================

interface FullContract {
  incoming: { notification: { id: string; title: string } };
  outgoing: { 'mark-read': { notificationId: string } };
  requests: { 'get-balance': { payload: { userId: string }; response: { balance: number } } };
}

interface ReceiveOnly {
  incoming: { tick: { n: number } };
}

// ===========================================================================
// 1. Base socket: on/send typed from the contract
// ===========================================================================

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

// Connection API is always present
const _state: string = socket.getState();
void _state;
socket.connect();
socket.disconnect(4001, 'bye');

// ===========================================================================
// 2. Omitting outgoing removes send()
// ===========================================================================

const recv = client<ReceiveOnly>()(connect('wss://example.com'));
recv.on('tick', (data) => {
  const _n: number = data.n;
  void _n;
});

// @ts-expect-error — no outgoing in the contract, so send() does not exist
recv.send;

// ===========================================================================
// 3. Primitive inference: a primitive's _typeFn adds API surface
// ===========================================================================

interface PingApiTypeFn extends TypeFn {
  readonly _api: { ping(): number };
}

function pingPrimitive(): PrimitiveSpec<PingApiTypeFn> {
  return { _tag: 'ping-test' };
}

const withApi = client<FullContract>()(connect('wss://example.com'), pingPrimitive());
const _pong: number = withApi.ping();
void _pong;

// Base API still present alongside the primitive API
withApi.on('notification', () => {});

// A config-only primitive (EmptyTypeFn) adds nothing
function noop(): PrimitiveSpec<EmptyTypeFn> {
  return { _tag: 'noop-test' };
}
const plain = client<FullContract>()(connect('wss://example.com'), noop());
// @ts-expect-error — noop adds no methods
plain.ping;

// ===========================================================================
// 4. ValidatePrimitives: unmet contract requirement becomes `never`
// ===========================================================================

function needsChannels(): PrimitiveSpec<EmptyTypeFn, { channels: Record<string, any> }> {
  return { _tag: 'needs-channels' };
}

// @ts-expect-error — FullContract has no `channels`, so the primitive slot is `never`
client<FullContract>()(connect('wss://example.com'), needsChannels());
