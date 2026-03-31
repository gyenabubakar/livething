/* oxlint-disable @typescript-eslint/no-explicit-any -- type test file */
/**
 * Type-level tests for the Socket class and createSocket factory.
 *
 * Verifies the full integration: contract typing on send/on, plugin API
 * merging, plugin validation, options typing, and the linked binary options.
 */

import { Plugin } from '~/plugins/base.ts';
import type { createSocket } from '~/create-socket.ts';
import type { MiddlewareMessage } from '~/middleware.ts';
import type { FullSocketOptions } from '~/options.ts';
import type { TypeFn } from '~/plugins/types.ts';
import type { CloseEvent } from '~/socket/socket.ts';
import type { ConnectionQuality, ConnectionState, SocketContract, StaticApi } from '~/types.ts';

// ===========================================================================
// Test contract
// ===========================================================================

interface TestContract extends SocketContract {
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
    };
  };
  requests: {
    'get-balance': {
      payload: { userId: string };
      response: { balance: number };
    };
  };
}

// ===========================================================================
// Test plugins
// ===========================================================================

// Static API plugin — adds getCount() regardless of contract
class MetricsPlugin extends Plugin<StaticApi<{ getCount(event: string): number }>> {
  id = 'metrics';
}

// Contract-dependent plugin — adds channel() typed against contract channels
interface ChannelsTypeFn extends TypeFn {
  readonly _api: this['_contract'] extends { channels: infer C }
    ? { channel<K extends keyof C>(name: K): C[K] }
    : {};
}

class ChannelsPlugin extends Plugin<ChannelsTypeFn, { channels: Record<string, any> }> {
  id = 'channels';
}

// Contract-dependent plugin — adds request() typed against contract requests
interface RequestResponseTypeFn extends TypeFn {
  readonly _api: this['_contract'] extends {
    requests: infer R extends Record<string, { payload: any; response: any }>;
  }
    ? {
        request<K extends keyof R>(
          event: K,
          payload: R[K]['payload'],
          options?: { timeout?: number },
        ): Promise<R[K]['response']>;
      }
    : {};
}

class RequestResponsePlugin extends Plugin<
  RequestResponseTypeFn,
  { requests: Record<string, any> }
> {
  id = 'request-response';
}

// ===========================================================================
// 1. Base socket methods (no plugins)
// ===========================================================================

declare const bare: ReturnType<typeof createSocket<TestContract>>;

// Connection lifecycle
bare.connect();
bare.disconnect();
bare.disconnect(4001, 'auth expired');

// State
const _state: ConnectionState = bare.getState();
void _state;
const _quality: ConnectionQuality = bare.getQuality();
void _quality;
const _latency: number | null = bare.getLatency();
void _latency;

// Subscribe
const _unsub: () => void = bare.subscribe(() => {});
void _unsub;

// Properties
const _ws: WebSocket | null = bare.ws;
void _ws;
const _proto: string | null = bare.protocol;
void _proto;

// on() typed against incoming
bare.on('notification', (data) => {
  const _id: string = data.id;
  const _title: string = data.title;
  void _id;
  void _title;
});

// @ts-expect-error — 'foo' not in incoming
bare.on('foo', () => {});

// @ts-expect-error — 'mark-read' is outgoing, not incoming
bare.on('mark-read', () => {});

// send() typed against outgoing, returns boolean
const _sent: boolean = bare.send('mark-read', { notificationId: '123' });
void _sent;

bare.send('typing', { channelId: '456' }, { ttl: 5_000 });

// @ts-expect-error — 'foo' not in outgoing
bare.send('foo', {});

// @ts-expect-error — wrong payload
bare.send('mark-read', { wrong: true });

// sendBinary
bare.sendBinary(new ArrayBuffer(8));
bare.sendBinary(new Uint8Array(8));

// Lifecycle callbacks — all return unsubscribe functions
const _u1: () => void = bare.onOpen(() => {});
const _u2: () => void = bare.onReconnect(() => {});
const _u3: () => void = bare.onReconnectFailed(() => {});
const _u4: () => void = bare.onClose((_event: CloseEvent) => {});
const _u5: () => void = bare.onError((_error: Event) => {});
const _u6: () => void = bare.onQualityChange((_quality: ConnectionQuality, _latency: number) => {});
(void _u1, _u2, _u3, _u4, _u5, _u6);

// Middleware
bare.use((_msg: MiddlewareMessage) => null);

// Debug
bare.setDebug(true);

// ===========================================================================
// 2. Socket with plugins — APIs are merged
// ===========================================================================

declare const withPlugins: ReturnType<
  typeof createSocket<TestContract, [MetricsPlugin, ChannelsPlugin, RequestResponsePlugin]>
>;

// Base methods still work
withPlugins.connect();
withPlugins.on('notification', (data) => {
  const _title: string = data.title;
  void _title;
});
withPlugins.send('mark-read', { notificationId: '123' });

// MetricsPlugin API
withPlugins.getCount('notification');

// ChannelsPlugin API — typed against contract channels
withPlugins.channel('chat');

// @ts-expect-error — 'billing' not in channels
withPlugins.channel('billing');

// RequestResponsePlugin API — typed against contract requests
const _balance: Promise<{ balance: number }> = withPlugins.request('get-balance', {
  userId: '123',
});
void _balance;

// @ts-expect-error — 'foo' not in requests
withPlugins.request('foo', {});

// ===========================================================================
// 3. Plugin validation — missing contract requirements
// ===========================================================================

// Plugin validation (ChannelsPlugin requires `channels` in the contract) is
// tested in plugins/types.test.ts section 5 via ValidatePlugins directly.
// The error surfaces when calling createSocket with a real plugins array,
// not when using ReturnType with explicit type params.

// ===========================================================================
// 4. Receive-only contract — send() should still exist but be empty
// ===========================================================================

interface ReceiveOnlyContract extends SocketContract {
  incoming: { event: { data: string } };
}

declare const receiveOnly: ReturnType<typeof createSocket<ReceiveOnlyContract>>;
receiveOnly.on('event', (data) => {
  const _d: string = data.data;
  void _d;
});

// send() exists on the class but outgoing is empty, so no valid event names
// @ts-expect-error — no outgoing events defined
receiveOnly.send('anything', {});

// ===========================================================================
// 5. Empty contract — minimal socket
// ===========================================================================

interface EmptyContract extends SocketContract {}

declare const empty: ReturnType<typeof createSocket<EmptyContract>>;
empty.connect();
empty.disconnect();
empty.getState();

// @ts-expect-error — no incoming events
empty.on('anything', () => {});

// @ts-expect-error — no outgoing events
empty.send('anything', {});

// ===========================================================================
// 6. Binary options — linked pair enforcement
// ===========================================================================

// Both binaryType and parseBinary provided — valid
const _validBinaryOpts: FullSocketOptions<EmptyContract> = {
  binaryType: 'arraybuffer',
  parseBinary: (_data: ArrayBuffer) => null,
};
void _validBinaryOpts;

// Neither provided — valid
const _noBinaryOpts: FullSocketOptions<EmptyContract> = {};
void _noBinaryOpts;

// binaryType without parseBinary — should be a type error
// @ts-expect-error — binaryType requires parseBinary
const _binaryNoParser: FullSocketOptions<EmptyContract> = {
  binaryType: 'arraybuffer',
};
void _binaryNoParser;
