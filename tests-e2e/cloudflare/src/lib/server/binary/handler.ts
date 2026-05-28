import { contract, implement, incoming, outgoing, t } from '@wskit/server';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

export const binaryContract = contract('binary', {
  env: t<Env>(),
  binary: true,
  meta: t<{ username: string }>(),
  definitions: [
    incoming('broadcast-all', v.object({ size: v.number() })),
    incoming('broadcast-exclude-self', v.object({ size: v.number() })),
    incoming('send-self-binary', v.object({ size: v.number() })),
    outgoing('binary-meta', v.object({ size: v.number(), username: v.string() })),
    outgoing('binary-hook-error-observed', v.object({ message: v.string() })),
  ],
});

export const binaryHandler = implement(binaryContract)
  .onUpgrade((req) => requireUsername(req))
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
  .on('broadcast-all', (ctx, payload) => {
    ctx.broadcastBinary(new Uint8Array(payload.size).buffer);
  })
  .on('broadcast-exclude-self', (ctx, payload) => {
    ctx.broadcastBinary(new Uint8Array(payload.size).buffer, { excludeSelf: true });
  })
  .on('send-self-binary', (ctx, payload) => {
    ctx.sendBinary(new Uint8Array(payload.size).buffer);
  })
  .build();

export type BinaryClient = InferClient<typeof binaryHandler>;
