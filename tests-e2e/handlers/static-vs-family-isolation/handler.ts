import { emits, server, t } from '@livething/server';
import { channels } from '@livething/server/channels';
import { dedup } from '@livething/server/dedup';
import { sequence } from '@livething/server/sequence';
import { tags } from '@livething/server/tags';
import * as v from 'valibot';
import type { InferClient } from '@livething/server';
import { requireUsernameWithUserTag } from '../_shared/upgrade.ts';

const MsgPayload = v.object({ from: v.string(), text: v.string() });
const SendInGeneralPayload = v.object({ text: v.string() });
const SendInRoomPayload = v.object({ name: v.string(), text: v.string() });

const TagSelfPayload = v.object({ tag: v.string() });
const TagAckPayload = v.object({ tag: v.string() });

const ObserveStaticPayload = v.object({ name: v.string() });
const ObserveFamilyPayload = v.object({ name: v.string() });
const ObserveResultPayload = v.object({
  where: v.string(),
  name: v.string(),
  count: v.number(),
});

const KickStaticPayload = v.object({
  name: v.string(),
  tag: v.string(),
  reason: v.string(),
});
const KickFamilyPayload = v.object({
  name: v.string(),
  tag: v.string(),
  reason: v.string(),
});
const KickAckPayload = v.object({ where: v.string() });

const base = server({
  upgrade: (request) => requireUsernameWithUserTag(request),
  capabilities: [
    dedup(),
    sequence({ persist: true }),
    channels(),
    tags((ephemeral) => [ephemeral('user', t<string>()), ephemeral('label', t<string>())]),
    emits({
      'tag-ack': t<v.InferOutput<typeof TagAckPayload>>(),
      'observe-result': t<v.InferOutput<typeof ObserveResultPayload>>(),
      'kick-ack': t<v.InferOutput<typeof KickAckPayload>>(),
    }),
  ],
});

const handleTagSelf = base.on('tag-self', {
  input: TagSelfPayload,
  run(ctx, payload) {
    ctx.tags.ephemeral('label').add(payload.tag);
    ctx.send('tag-ack', { tag: payload.tag });
  },
});

const handleObserveStatic = base.on('observe-static', {
  input: ObserveStaticPayload,
  run(ctx, payload) {
    void payload.name;
    const count = ctx.channels.get('general').members().length;
    ctx.send('observe-result', { where: 'static', name: 'general', count });
  },
});

const handleObserveFamily = base.on('observe-family', {
  input: ObserveFamilyPayload,
  run(ctx, payload) {
    const count = ctx.channels.get('rooms', payload.name).members().length;
    ctx.send('observe-result', { where: 'family', name: payload.name, count });
  },
});

const handleKickStatic = base.on('kick-static', {
  input: KickStaticPayload,
  async run(ctx, payload) {
    void payload.name;
    await ctx.channels
      .get('general')
      .kick(ctx.tags.ephemeral('label').ref(payload.tag), { reason: payload.reason });
    ctx.send('kick-ack', { where: 'static' });
  },
});

const handleKickFamily = base.on('kick-family', {
  input: KickFamilyPayload,
  async run(ctx, payload) {
    await ctx.channels
      .get('rooms', payload.name)
      .kick(ctx.tags.ephemeral('label').ref(payload.tag), { reason: payload.reason });
    ctx.send('kick-ack', { where: 'family' });
  },
});

const general = base.channel('general', {
  capabilities: [emits({ msg: t<v.InferOutput<typeof MsgPayload>>() })],
});

const handleSendInGeneral = general.on('send-in-general', {
  input: SendInGeneralPayload,
  run(ctx, payload) {
    ctx.channel.broadcast('msg', { from: 'static', text: payload.text }, { includeSelf: true });
  },
});

const room = base.channel(['rooms', 'room:{id}'], {
  capabilities: [emits({ msg: t<v.InferOutput<typeof MsgPayload>>() })],
});

const handleSendInRoom = room.on('send-in-room', {
  input: SendInRoomPayload,
  run(ctx, payload) {
    void payload.name;
    ctx.channel.broadcast('msg', { from: 'family', text: payload.text }, { includeSelf: true });
  },
});

export const staticVsFamilyIsolationDefinition = base.assemble({
  handlers: [
    handleTagSelf,
    handleObserveStatic,
    handleObserveFamily,
    handleKickStatic,
    handleKickFamily,
    handleSendInGeneral,
    handleSendInRoom,
  ],
});

export type StaticVsFamilyIsolationClient = InferClient<typeof staticVsFamilyIsolationDefinition>;
