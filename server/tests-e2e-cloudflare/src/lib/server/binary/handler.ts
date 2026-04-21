import { event, server } from '@wskit/server';
import { withLifecycle } from '@wskit/server/lifecycle';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

const BinaryMeta = event('binary-meta', v.object({ size: v.number(), username: v.string() }));
const BroadcastAll = event('broadcast-all', v.object({ size: v.number() }));
const BroadcastExcludeSelf = event('broadcast-exclude-self', v.object({ size: v.number() }));

export const binaryHandler = withLifecycle(server<Env>('binary'))
  .outgoing(BinaryMeta)
  .onUpgrade((request) => requireUsername(request))
  .onBinary((ctx, bytes) => {
    ctx.send('binary-meta', { size: bytes.byteLength, username: ctx.meta.username });
  })
  .incoming(BroadcastAll, (ctx, payload) => {
    ctx.broadcastBinary(new Uint8Array(payload.size).buffer);
  })
  .incoming(BroadcastExcludeSelf, (ctx, payload) => {
    ctx.broadcastBinary(new Uint8Array(payload.size).buffer, { excludeSelf: true });
  })
  .build();
