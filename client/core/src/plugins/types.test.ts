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

import { Plugin } from '@/plugins/base.ts';
import type {
  Apply,
  ApplyPlugins,
  SocketWithPlugins,
  TypeFn,
  ValidatePlugins,
} from '@/plugins/types.ts';
import type { IncomingOf, OutgoingOf, Requires, SocketContract, StaticApi } from '@/types.ts';

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
