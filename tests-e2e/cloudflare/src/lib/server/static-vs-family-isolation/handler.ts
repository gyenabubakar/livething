import { channel, contract, implement, incoming, outgoing, scope, t } from '@wskit/server';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

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

export const staticVsFamilyIsolationContract = contract('static-vs-family-isolation', {
  env: t<Env>(),
  dedup: true,
  sequence: { persist: true },
  meta: t<{ username: string }>(),
  tags: (ephemeral) => [ephemeral('user', t<string>()), ephemeral('label', t<string>())],
  definitions: [
    incoming('tag-self', TagSelfPayload),
    incoming('observe-static', ObserveStaticPayload),
    incoming('observe-family', ObserveFamilyPayload),
    incoming('kick-static', KickStaticPayload),
    incoming('kick-family', KickFamilyPayload),

    outgoing('tag-ack', TagAckPayload),
    outgoing('observe-result', ObserveResultPayload),
    outgoing('kick-ack', KickAckPayload),

    channel('general', {
      definitions: [incoming('send-in-general', SendInGeneralPayload), outgoing('msg', MsgPayload)],
    }),
    channel(scope('rooms', 'room:{id}'), {
      definitions: [incoming('send-in-room', SendInRoomPayload), outgoing('msg', MsgPayload)],
    }),
  ],
});

export const staticVsFamilyIsolationHandler = implement(staticVsFamilyIsolationContract)
  .onUpgrade((request, helpers) => requireUsername(request, helpers))

  .on('tag-self', (ctx, payload) => {
    ctx.tags.ephemeral('label').add(payload.tag);
    ctx.send('tag-ack', { tag: payload.tag });
  })
  .on('observe-static', (ctx, payload) => {
    void payload.name;
    const count = ctx.channels.get('general').members().length;
    ctx.send('observe-result', { where: 'static', name: 'general', count });
  })
  .on('observe-family', (ctx, payload) => {
    const count = ctx.channels.get('rooms', payload.name).members().length;
    ctx.send('observe-result', { where: 'family', name: payload.name, count });
  })
  .on('kick-static', async (ctx, payload) => {
    void payload.name;
    await ctx.channels
      .get('general')
      .kick(ctx.tags.ephemeral('label').ref(payload.tag), payload.reason);
    ctx.send('kick-ack', { where: 'static' });
  })
  .on('kick-family', async (ctx, payload) => {
    await ctx.channels
      .get('rooms', payload.name)
      .kick(ctx.tags.ephemeral('label').ref(payload.tag), payload.reason);
    ctx.send('kick-ack', { where: 'family' });
  })

  .channel('general', (ch) =>
    ch.on('send-in-general', (ctx, payload) => {
      ctx.channel.broadcast('msg', { from: 'static', text: payload.text }, { excludeSelf: false });
    }),
  )

  .channel('rooms', (ch) =>
    ch.on('send-in-room', (ctx, payload) => {
      void payload.name;
      ctx.channel.broadcast('msg', { from: 'family', text: payload.text }, { excludeSelf: false });
    }),
  )

  .build();

export type StaticVsFamilyIsolationClient = InferClient<typeof staticVsFamilyIsolationHandler>;
