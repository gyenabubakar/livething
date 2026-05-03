import { event, scope, server } from '@wskit/server';
import { withChannels } from '@wskit/server/channels';
import { withDedup } from '@wskit/server/dedup';
import { withLifecycle } from '@wskit/server/lifecycle';
import { withSequence } from '@wskit/server/sequence';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

const Msg = event('msg', v.object({ from: v.string(), text: v.string() }));

const SendInGeneral = event('send-in-general', v.object({ text: v.string() }));
const SendInRoom = event('send-in-room', v.object({ name: v.string(), text: v.string() }));

const TagSelf = event('tag-self', v.object({ tag: v.string() }));
const TagAck = event('tag-ack', v.object({ tag: v.string() }));

const ObserveStatic = event('observe-static', v.object({ name: v.string() }));
const ObserveFamily = event('observe-family', v.object({ name: v.string() }));
const ObserveResult = event(
  'observe-result',
  v.object({ where: v.string(), name: v.string(), count: v.number() }),
);

const KickStatic = event(
  'kick-static',
  v.object({ name: v.string(), tag: v.string(), reason: v.string() }),
);
const KickFamily = event(
  'kick-family',
  v.object({ name: v.string(), tag: v.string(), reason: v.string() }),
);
const KickAck = event('kick-ack', v.object({ where: v.string() }));

const base = withChannels(
  withSequence(withDedup(withLifecycle(server<Env>('static-vs-family-isolation')))),
)
  .sequence({ persist: true })
  .dedup()
  .onUpgrade((request) => requireUsername(request))
  .outgoing(TagAck)
  .outgoing(ObserveResult)
  .outgoing(KickAck);

const generalChannel = base.channel('general', (c) =>
  c.outgoing(Msg).incoming(SendInGeneral, (ctx, payload) => {
    ctx.channel.broadcast('msg', { from: 'static', text: payload.text }, { excludeSelf: false });
  }),
);

const roomsFamily = base.channel(scope('rooms', /^room:.+$/), (c) =>
  c.outgoing(Msg).incoming(SendInRoom, (ctx, payload) => {
    void payload.name;
    ctx.channel.broadcast('msg', { from: 'family', text: payload.text }, { excludeSelf: false });
  }),
);

export const staticVsFamilyIsolationHandler = base
  .use(generalChannel)
  .use(roomsFamily)
  .incoming(TagSelf, (ctx, payload) => {
    ctx.tag(payload.tag);
    ctx.send('tag-ack', { tag: payload.tag });
  })
  .incoming(ObserveStatic, (ctx, payload) => {
    void payload.name;
    const count = ctx.channels.get('general').members().length;
    ctx.send('observe-result', { where: 'static', name: 'general', count });
  })
  .incoming(ObserveFamily, (ctx, payload) => {
    const count = ctx.channels.get('rooms', payload.name).members().length;
    ctx.send('observe-result', { where: 'family', name: payload.name, count });
  })
  .incoming(KickStatic, async (ctx, payload) => {
    void payload.name;
    await ctx.channels.get('general').kick(payload.tag, payload.reason);
    ctx.send('kick-ack', { where: 'static' });
  })
  .incoming(KickFamily, async (ctx, payload) => {
    await ctx.channels.get('rooms', payload.name).kick(payload.tag, payload.reason);
    ctx.send('kick-ack', { where: 'family' });
  })
  .build();
