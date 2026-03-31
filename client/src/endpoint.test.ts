/* oxlint-disable @typescript-eslint/no-explicit-any -- type test file uses `any` for casting in type assertions */
/**
 * Type-level tests for the Endpoint interface.
 *
 * Verifies that `on()` and `send()` appear/disappear based on whether
 * `incoming` and `outgoing` are defined, and that event names and
 * payloads are correctly constrained.
 */

import type { Endpoint } from '~/endpoint.ts';

// ===========================================================================
// Test event maps
// ===========================================================================

interface TestIncoming {
  notification: { id: string; title: string };
  'user-online': { userId: string };
}

interface TestOutgoing {
  'mark-read': { notificationId: string };
  typing: { channelId: string };
}

// ===========================================================================
// 1. Both incoming and outgoing defined
// ===========================================================================

// When both are defined, both `on` and `send` exist.
type Full = Endpoint<TestIncoming, TestOutgoing>;
const full: Full = {} as any;

// on() is typed against incoming events
const unsub: () => void = full.on('notification', (data) => {
  const _id: string = data.id;
  const _title: string = data.title;
  void _id;
  void _title;
});
void unsub;

full.on('user-online', (data) => {
  const _userId: string = data.userId;
  void _userId;
});

// @ts-expect-error — 'foo' is not an incoming event
full.on('foo', () => {});

// @ts-expect-error — 'mark-read' is outgoing, not incoming
full.on('mark-read', () => {});

// send() is typed against outgoing events
const sent: boolean = full.send('mark-read', { notificationId: '123' });
void sent;

full.send('typing', { channelId: '456' });

// send() with TTL option
full.send('typing', { channelId: '456' }, { ttl: 5_000 });

// @ts-expect-error — 'foo' is not an outgoing event
full.send('foo', {});

// @ts-expect-error — wrong payload for 'mark-read'
full.send('mark-read', { wrong: true });

// @ts-expect-error — 'notification' is incoming, not outgoing
full.send('notification', { id: '1', title: 'hi' });

// ===========================================================================
// 2. Only incoming defined (receive-only)
// ===========================================================================

// When only incoming is defined, `on` exists but `send` does not.
type ReceiveOnly = Endpoint<TestIncoming>;
const receiveOnly: ReceiveOnly = {} as any;

receiveOnly.on('notification', (data) => {
  const _title: string = data.title;
  void _title;
});

// @ts-expect-error — send does not exist on a receive-only endpoint
receiveOnly.send;

// ===========================================================================
// 3. Only outgoing defined (send-only)
// ===========================================================================

// When only outgoing is defined, `send` exists but `on` does not.
type SendOnly = Endpoint<{}, TestOutgoing>;
const sendOnly: SendOnly = {} as any;

sendOnly.send('mark-read', { notificationId: '123' });

// @ts-expect-error — on does not exist on a send-only endpoint
sendOnly.on;

// ===========================================================================
// 4. Neither defined (empty endpoint)
// ===========================================================================

// When neither is defined, the endpoint is an empty object.
type Empty = Endpoint;
const empty: Empty = {};

// @ts-expect-error — on does not exist
empty.on;

// @ts-expect-error — send does not exist
empty.send;

// ===========================================================================
// 5. send() return type
// ===========================================================================

// send() returns boolean, not void
type SendReturn = ReturnType<Endpoint<{}, TestOutgoing>['send']>;
const _sendReturn: SendReturn = true;
void _sendReturn;

// ===========================================================================
// 6. on() return type (unsubscribe function)
// ===========================================================================

// on() returns () => void
type OnReturn = ReturnType<Endpoint<TestIncoming>['on']>;
function _onReturn(): void {}
const _checkOnReturn: OnReturn = _onReturn;
void _checkOnReturn;

// ===========================================================================
// 7. Endpoint as a function parameter
// ===========================================================================

// Utility functions can accept any endpoint — this is the shared interface
// pattern described in the spec.
function logEvents(_ep: Endpoint<Record<string, unknown>>) {}
logEvents(full);
logEvents(receiveOnly);
