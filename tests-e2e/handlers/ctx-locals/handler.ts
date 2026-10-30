import { emits, localKey, server, t } from '@livething/server';
import { channels } from '@livething/server/channels';
import { clientRequests } from '@livething/server/client-requests';
import * as v from 'valibot';
import type { InferClient } from '@livething/server';
import { requireUsername } from '../_shared/upgrade.ts';

const EchoPayload = v.object({ text: v.string() });

export const TopKey = localKey<{ tag: string }>('top');
export const NsKey = localKey<{ tag: string }>('ns');
export const ChannelKey = localKey<{ tag: string }>('channel');

const base = server({
  upgrade: (request) => requireUsername(request),
  capabilities: [emits({ echoed: t<{ text: string }>() }), clientRequests(), channels()],
});

base.intercept((ctx) => {
  ctx.provide(TopKey, { tag: 'top' });
});

const handleEcho = base.on('echo', {
  input: EchoPayload,
  run(ctx, input) {
    const top = ctx.inject(TopKey);
    const ns = ctx.inject(NsKey);
    ctx.send('echoed', { text: `${input.text}:${top?.tag ?? 'none'}:${ns?.tag ?? 'none'}` });
  },
});

const handleLookup = base.request('lookup', {
  input: EchoPayload,
  run(ctx, input) {
    const top = ctx.inject(TopKey);
    const ns = ctx.inject(NsKey);
    return { text: `${input.text}:${top?.tag ?? 'none'}:${ns?.tag ?? 'none'}` };
  },
});

const room = base.channel('room', {
  capabilities: [emits({ echoed: t<{ text: string }>() })],
});

room.intercept((ctx) => {
  ctx.provide(ChannelKey, { tag: 'channel' });
});

const handleRoomEcho = room.on('echo', {
  input: EchoPayload,
  run(ctx, input) {
    const top = ctx.inject(TopKey);
    const chk = ctx.inject(ChannelKey);
    ctx.channel.send('echoed', {
      text: `${input.text}:${top?.tag ?? 'none'}:${chk?.tag ?? 'none'}`,
    });
  },
});

const handleRoomLookup = room.request('lookup', {
  input: EchoPayload,
  run(ctx, input) {
    const top = ctx.inject(TopKey);
    const chk = ctx.inject(ChannelKey);
    return { text: `${input.text}:${top?.tag ?? 'none'}:${chk?.tag ?? 'none'}` };
  },
});

export const ctxLocalsDefinition = base.assemble({
  handlers: [handleEcho, handleLookup, handleRoomEcho, handleRoomLookup],
});

export type CtxLocalsClient = InferClient<typeof ctxLocalsDefinition>;
