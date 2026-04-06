import { ack as _ack } from '~/ack/index.ts';
import { channel as _channel, scope } from '~/channel/index.ts';
import { heartbeat as _heartbeat } from '~/heartbeat/index.ts';
import { incoming as _incoming } from '~/incoming/index.ts';
import { received, server, t } from '~/index.ts';
import { intercept as _intercept } from '~/intercept/index.ts';
import { namespace as _namespace } from '~/namespace/index.ts';
import { outgoing as _outgoing } from '~/outgoing/index.ts';
import { passive as _passive } from '~/passive/index.ts';
import { replay as _replay } from '~/replay/index.ts';
import { request as _request } from '~/request/index.ts';

declare global {
  interface WskitServerRegistry {
    chat: {
      ctx: {
        send(event: 'message', payload: { text: string }): void;
        broadcast(event: 'message', payload: { text: string }): void;
        ack(): void;
      };
      outgoing: {
        message: { text: string };
      };
      incomingContexts: {
        'send-message': {
          send(event: 'message', payload: { text: string }): void;
          broadcast(event: 'message', payload: { text: string }): void;
          ack(): void;
        };
        dismiss: {
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
          send(event: 'message', payload: { text: string }): void;
          broadcast(event: 'message', payload: { text: string }): void;
          ack(): void;
        };
      };
      postInterceptContexts: {
        'send-message': {
          send(event: 'message', payload: { text: string }): void;
          broadcast(event: 'message', payload: { text: string }): void;
          ack(): void;
        };
        dismiss: {
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
  }
}

const { define, incoming, outgoing } = server('chat', {
  _ack,
  _heartbeat,
  _incoming,
  _outgoing,
  _passive,
});

const directCapabilities = define(
  outgoing('message', t<{ text: string }>()),
  incoming(
    received('send-message', (value: unknown) => value as { text: string }),
    async (ctx, payload) => {
      ctx.ack();
      ctx.send('message', payload);
      ctx.broadcast('message', payload);

      // @ts-expect-error generated ctx should reject unknown outgoing events
      ctx.send('anything-at-runtime-for-now', payload);

      // @ts-expect-error generated ctx should reject unknown outgoing events
      ctx.broadcast('another-event', payload);
    },
  ),
);

void directCapabilities;

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
