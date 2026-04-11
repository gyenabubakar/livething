import { ack as _ack } from '~/ack/index.ts';
import {
  channel as _channel,
  onBeforeSubscribe as _onBeforeSubscribe,
  onSubscribe as _onSubscribe,
  onUnsubscribe as _onUnsubscribe,
  scope,
} from '~/channel/index.ts';
import { heartbeat as _heartbeat } from '~/heartbeat/index.ts';
import { incoming as _incoming } from '~/incoming/index.ts';
import { received, server, t } from '~/index.ts';
import { intercept as _intercept } from '~/intercept/index.ts';
import { onConnect as _onConnect, onError as _onError } from '~/lifecycle.ts';
import { namespace as _namespace } from '~/namespace/index.ts';
import { outgoing as _outgoing } from '~/outgoing/index.ts';
import { replay as _replay } from '~/replay/index.ts';
import { request as _request } from '~/request/index.ts';
import { scheduled as _scheduled } from '~/scheduled/index.ts';

declare global {
  interface WskitServerRegistry {
    chat: {
      ctx: {
        id: string;
        meta: Record<string, unknown>;
        bufferedAmount: number;
        latency: number | null;
        send(event: 'message', payload: { text: string }): void;
        broadcast(event: 'message', payload: { text: string }): void;
        ack(): void;
      };
      outgoing: {
        message: { text: string };
      };
      incomingContexts: {
        'send-message': {
          id: string;
          meta: Record<string, unknown>;
          bufferedAmount: number;
          latency: number | null;
          send(event: 'message', payload: { text: string }): void;
          broadcast(event: 'message', payload: { text: string }): void;
          ack(): void;
        };
        dismiss: {
          id: string;
          meta: Record<string, unknown>;
          bufferedAmount: number;
          latency: number | null;
          send(event: 'message', payload: { text: string }): void;
          broadcast(event: 'message', payload: { text: string }): void;
          ack(): void;
          namespace: {
            name: 'notifications';
            send(event: 'alert', payload: { id: string }): void;
            broadcast(event: 'alert', payload: { id: string }): void;
          };
        };
        'start-typing': {
          id: string;
          meta: Record<string, unknown>;
          bufferedAmount: number;
          latency: number | null;
          send(event: 'message', payload: { text: string }): void;
          broadcast(event: 'message', payload: { text: string }): void;
          ack(): void;
          channel: {
            name: string;
            send(event: 'typing', payload: { userId: string }): void;
            broadcast(event: 'typing', payload: { userId: string }): void;
            sendReplay(
              event: 'typing',
              payload: { userId: string },
              meta: { seq: number; messageId: string },
            ): void;
          };
        };
      };
      requestContexts: {
        'get-status': {
          id: string;
          meta: Record<string, unknown>;
          bufferedAmount: number;
          latency: number | null;
          send(event: 'message', payload: { text: string }): void;
          broadcast(event: 'message', payload: { text: string }): void;
          ack(): void;
        };
      };
      postInterceptContexts: {
        'send-message': {
          id: string;
          meta: Record<string, unknown>;
          bufferedAmount: number;
          latency: number | null;
          send(event: 'message', payload: { text: string }): void;
          broadcast(event: 'message', payload: { text: string }): void;
          ack(): void;
        };
        dismiss: {
          id: string;
          meta: Record<string, unknown>;
          bufferedAmount: number;
          latency: number | null;
          send(event: 'message', payload: { text: string }): void;
          broadcast(event: 'message', payload: { text: string }): void;
          ack(): void;
          namespace: {
            name: 'notifications';
            send(event: 'alert', payload: { id: string }): void;
            broadcast(event: 'alert', payload: { id: string }): void;
          };
        };
        'start-typing': {
          id: string;
          meta: Record<string, unknown>;
          bufferedAmount: number;
          latency: number | null;
          send(event: 'message', payload: { text: string }): void;
          broadcast(event: 'message', payload: { text: string }): void;
          ack(): void;
          channel: {
            name: string;
            send(event: 'typing', payload: { userId: string }): void;
            broadcast(event: 'typing', payload: { userId: string }): void;
            sendReplay(
              event: 'typing',
              payload: { userId: string },
              meta: { seq: number; messageId: string },
            ): void;
          };
        };
      };
      namespaces: {
        notifications: {
          ctx: {
            id: string;
            meta: Record<string, unknown>;
            bufferedAmount: number;
            latency: number | null;
            send(event: 'message', payload: { text: string }): void;
            broadcast(event: 'message', payload: { text: string }): void;
            ack(): void;
            namespace: {
              name: 'notifications';
              send(event: 'alert', payload: { id: string }): void;
              broadcast(event: 'alert', payload: { id: string }): void;
            };
          };
        };
      };
      channels: {
        rooms: {
          ctx: {
            id: string;
            meta: Record<string, unknown>;
            bufferedAmount: number;
            latency: number | null;
            send(event: 'message', payload: { text: string }): void;
            broadcast(event: 'message', payload: { text: string }): void;
            ack(): void;
            channel: {
              name: string;
              send(event: 'typing', payload: { userId: string }): void;
              broadcast(event: 'typing', payload: { userId: string }): void;
              sendReplay(
                event: 'typing',
                payload: { userId: string },
                meta: { seq: number; messageId: string },
              ): void;
            };
          };
        };
      };
    };
    'chat-scheduled': {
      ctx: {
        id: string;
        meta: Record<string, unknown>;
        bufferedAmount: number;
        latency: number | null;
        schedule(
          taskId: 'expire-hold',
          options: { time: number; data?: { orderId: string } },
        ): void;
        cancelScheduled(taskId: 'expire-hold', filter?: Partial<{ orderId: string }>): void;
      };
      incomingContexts: {
        'place-order': {
          id: string;
          meta: Record<string, unknown>;
          bufferedAmount: number;
          latency: number | null;
          schedule(
            taskId: 'expire-hold',
            options: { time: number; data?: { orderId: string } },
          ): void;
          cancelScheduled(taskId: 'expire-hold', filter?: Partial<{ orderId: string }>): void;
        };
      };
      outgoing: {};
    };
  }
}

const { define, incoming, outgoing } = server('chat', {
  _ack,
  _heartbeat,
  _incoming,
  _outgoing,
});

const directCapabilities = define(
  outgoing('message', t<{ text: string }>()),
  incoming(
    received('send-message', (value: unknown) => value as { text: string }),
    async (ctx, payload) => {
      const _id: string = ctx.id;
      const _meta: Record<string, unknown> = ctx.meta;
      const _bufferedAmount: number = ctx.bufferedAmount;
      const _latency: number | null = ctx.latency;
      void _id;
      void _meta;
      void _bufferedAmount;
      void _latency;

      ctx.ack();
      ctx.send('message', payload);
      ctx.broadcast('message', payload);

      // @ts-expect-error generated ctx should reject unknown outgoing events
      ctx.send('anything-at-runtime-for-now', payload);

      // @ts-expect-error generated ctx should reject unknown outgoing events
      ctx.broadcast('another-event', payload);

      // @ts-expect-error generated ctx should reject unknown scheduled task names
      ctx.schedule('missing-task', { time: Date.now() });

      // @ts-expect-error generated ctx should reject wrong scheduled payload shapes
      ctx.schedule('expire-hold', {
        time: Date.now(),
        data: { wrong: true },
      });
    },
  ),
);

void directCapabilities;

const { define: scheduledDefine, incoming: scheduledIncoming } = server('chat-scheduled', {
  _incoming,
  _scheduled,
});

const scheduledCapabilities = scheduledDefine(
  _scheduled('expire-hold', t<{ orderId: string }>()),
  scheduledIncoming(
    received('place-order', (value: unknown) => value as { orderId: string }),
    async (ctx, payload) => {
      const _id: string = ctx.id;
      const _meta: Record<string, unknown> = ctx.meta;
      const _bufferedAmount: number = ctx.bufferedAmount;
      const _latency: number | null = ctx.latency;
      void _id;
      void _meta;
      void _bufferedAmount;
      void _latency;

      ctx.schedule('expire-hold', {
        time: Date.now(),
        data: { orderId: payload.orderId },
      });
      ctx.cancelScheduled('expire-hold', { orderId: payload.orderId });

      // @ts-expect-error generated ctx should reject unknown scheduled task names
      ctx.schedule('missing-task', { time: Date.now() });

      ctx.schedule(
        'expire-hold',
        // @ts-expect-error generated ctx should reject wrong scheduled payload shapes
        { time: Date.now(), data: { wrong: true } },
      );
    },
  ),
);

void scheduledCapabilities;

const {
  define: noAckDefine,
  incoming: noAckIncoming,
  outgoing: noAckOutgoing,
} = server('chat-no-ack', {
  _incoming,
  _outgoing,
});

const withoutAck = noAckDefine(
  noAckOutgoing('message', t<{ text: string }>()),
  noAckIncoming(
    received('send-message', (value: unknown) => value as { text: string }),
    async (ctx, payload) => {
      ctx.send('fallback-string-event', payload);

      // @ts-expect-error ack() should only appear when _ack was passed to server()
      ctx.ack();
    },
  ),
);

void withoutAck;

const {
  define: scopedDefine,
  incoming: scopedIncoming,
  outgoing: scopedOutgoing,
  request,
  intercept,
  namespace,
  channel,
  replay,
} = server('chat', {
  _ack,
  _incoming,
  _intercept,
  _namespace,
  _channel,
  _outgoing,
  _replay,
  _request,
});

const scopedCapabilities = scopedDefine(
  scopedOutgoing('message', t<{ text: string }>()),
  intercept('send-message', async (ctx, payload: { text: string }) => {
    ctx.ack();
    ctx.send('message', { text: payload.text });
    ctx.channels.members('room-1');

    // @ts-expect-error generated intercept ctx should reject unknown top-level outgoing events
    ctx.send('typing', { userId: payload.text });

    return payload;
  }),
  request(
    'get-status',
    async (ctx, payload: { room: string }) => {
      ctx.ack();
      ctx.send('message', { text: payload.room });

      // @ts-expect-error generated request ctx should reject unknown top-level outgoing events
      ctx.send('alert', { id: payload.room });

      return { ok: true };
    },
    { validator: (value: unknown) => value as { room: string } },
  ),
  namespace(
    'notifications',
    scopedOutgoing('alert', t<{ id: string }>()),
    intercept('dismiss', async (ctx, payload: { id: string }) => {
      const namespaceName: 'notifications' = ctx.namespace.name;
      void namespaceName;
      ctx.channels.kick('room-1', 'muted', 'dismissed');
      ctx.namespace.send('alert', { id: payload.id });
      ctx.send('message', { text: payload.id });

      // @ts-expect-error namespace ctx should keep scoped sends under ctx.namespace
      ctx.send('alert', { id: payload.id });

      return payload;
    }),
    scopedIncoming(
      received('dismiss', (value: unknown) => value as { id: string }),
      async (ctx, payload) => {
        const namespaceName: 'notifications' = ctx.namespace.name;
        void namespaceName;
        ctx.namespace.broadcast('alert', { id: payload.id });

        // @ts-expect-error namespace ctx should not expose channel helpers
        ctx.channel.send('typing', { userId: payload.id });
      },
    ),
  ),
  channel(
    scope('rooms', /^room-/),
    replay(),
    scopedOutgoing('typing', t<{ userId: string }>()),
    intercept('start-typing', async (ctx, payload: { userId: string }) => {
      const channelName: string = ctx.channel.name;
      void channelName;
      ctx.channel.send('typing', { userId: payload.userId });
      ctx.channel.sendReplay('typing', { userId: payload.userId }, { seq: 1, messageId: 'm1' });
      ctx.send('message', { text: payload.userId });

      // @ts-expect-error channel ctx should keep scoped sends under ctx.channel
      ctx.send('typing', { userId: payload.userId });

      return payload;
    }),
    scopedIncoming(
      received('start-typing', (value: unknown) => value as { userId: string }),
      async (ctx, payload) => {
        const channelName: string = ctx.channel.name;
        void channelName;
        ctx.channel.broadcast('typing', { userId: payload.userId });
        ctx.channel.sendReplay('typing', { userId: payload.userId }, { seq: 2, messageId: 'm2' });

        // @ts-expect-error channel ctx should not expose namespace helpers
        ctx.namespace.send('alert', { id: payload.userId });
      },
    ),
  ),
);

void scopedCapabilities;

const {
  define: lifecycleDefine,
  channel: lifecycleChannel,
  incoming: lifecycleIncoming,
  onBeforeSubscribe,
  onConnect,
  onError,
  onSubscribe,
  onUnsubscribe,
  outgoing: lifecycleOutgoing,
  scheduled,
} = server('chat', {
  _ack,
  _channel,
  _incoming,
  _onBeforeSubscribe,
  _onConnect,
  _onError,
  _onSubscribe,
  _onUnsubscribe,
  _outgoing,
  _scheduled,
});

const lifecycleCapabilities = lifecycleDefine(
  onConnect(async (ctx) => {
    ctx.ack();
    ctx.send('message', { text: 'connected' });
  }),
  onError(async (ctx, error) => {
    ctx.send('message', { text: String(error) });
  }),
  scheduled('flush', async (ctx, data: { force: boolean }) => {
    ctx.broadcast('message', { text: data.force ? 'forced' : 'queued' });
    ctx.getConnections();
    ctx.sendTo('admins', 'message', { text: 'scheduled' });
  }),
  lifecycleChannel(
    scope('rooms', /^room-/),
    lifecycleOutgoing('typing', t<{ userId: string }>()),
    onBeforeSubscribe(async (ctx, data?: { roomId: string }) => {
      const channelName: string = ctx.channel.name;
      void [channelName, data];
      ctx.channel.broadcast('typing', { userId: 'system' });
    }),
    onSubscribe(async (ctx) => {
      ctx.channel.broadcast('typing', { userId: 'joined' });
    }),
    onUnsubscribe(async (ctx) => {
      ctx.channel.broadcast('typing', { userId: 'left' });
    }),
    lifecycleIncoming(
      received('start-typing', (value: unknown) => value as { userId: string }),
      async (ctx, payload) => {
        ctx.channel.send('typing', { userId: payload.userId });
      },
    ),
  ),
);

void lifecycleCapabilities;
