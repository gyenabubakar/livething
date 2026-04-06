import { received, server, t } from '@wskit/server-codegen';
import { ack as _ack } from '@wskit/server-codegen/ack';
import { heartbeat as _heartbeat } from '@wskit/server-codegen/heartbeat';
import { incoming as _incoming } from '@wskit/server-codegen/incoming';
import { outgoing as _outgoing } from '@wskit/server-codegen/outgoing';
import type { InferClient } from '@wskit/server-codegen';

const { define, incoming, outgoing } = server('chat', {
  _ack,
  _heartbeat,
  _incoming,
  _outgoing,
});

const chat = define(
  outgoing('message', t<{ text: string }>()),
  outgoing('alert', t<{ level: 'info' | 'warn' }>()),
  incoming(
    received('send-message', (value: unknown) => value as { text: string }),
    async (ctx, payload) => {
      ctx.ack();

      ctx.send('message', { text: payload.text });
      ctx.broadcast('alert', { level: 'info' });

      // @ts-expect-error generated ctx should reject unknown outgoing events
      ctx.send('missing', {});
    },
  ),
);

export default chat;

type ChatClient = InferClient<typeof chat>;

const _incomingMessage: ChatClient['incoming']['message'] = {
  text: 'hello',
};

const _incomingAlert: ChatClient['incoming']['alert'] = {
  level: 'info',
};

void [_incomingMessage, _incomingAlert];

// @ts-expect-error generated outgoing map should reject unknown events
const _invalidIncoming: ChatClient['incoming']['missing'] = {};
void _invalidIncoming;
