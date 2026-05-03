import { event, server } from '@wskit/server';
import { withLifecycle } from '@wskit/server/lifecycle';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

const BinaryMeta = event('binary-meta', v.object({ size: v.number(), username: v.string() }));
const BinaryHookErrorObserved = event(
  'binary-hook-error-observed',
  v.object({ message: v.string() }),
);
const BroadcastAll = event('broadcast-all', v.object({ size: v.number() }));
const BroadcastExcludeSelf = event('broadcast-exclude-self', v.object({ size: v.number() }));
const SendSelfBinary = event('send-self-binary', v.object({ size: v.number() }));

export const binaryHandler = withLifecycle(server<Env>('binary'))
  .outgoing(BinaryMeta)
  .outgoing(BinaryHookErrorObserved)
  .onUpgrade((request) => requireUsername(request))
  .onBinary((ctx, bytes) => {
    const view = new Uint8Array(bytes);
    if (view[0] === 0xfe) {
      throw new Error('poison binary frame');
    }
    ctx.sendBinary(bytes);
    ctx.send('binary-meta', { size: bytes.byteLength, username: ctx.meta.username });
  })
  .onError((ctx, error) => {
    const message = error instanceof Error ? error.message : String(error);
    ctx.send('binary-hook-error-observed', { message });
  })
  .incoming(BroadcastAll, (ctx, payload) => {
    ctx.broadcastBinary(new Uint8Array(payload.size).buffer);
  })
  .incoming(BroadcastExcludeSelf, (ctx, payload) => {
    ctx.broadcastBinary(new Uint8Array(payload.size).buffer, { excludeSelf: true });
  })
  .incoming(SendSelfBinary, (ctx, payload) => {
    ctx.sendBinary(new Uint8Array(payload.size).buffer);
  })
  .build();
