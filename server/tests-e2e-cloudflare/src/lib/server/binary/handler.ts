import { event, server } from '@wskit/server';
import { withLifecycle } from '@wskit/server/lifecycle';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

const BinaryEchoed = event('binary-echoed', v.object({ size: v.number() }));

export const binaryHandler = withLifecycle(server<Env>('binary'))
  .outgoing(BinaryEchoed)
  .onUpgrade((request) => requireUsername(request))
  .onBinary((ctx, bytes) => {
    ctx.send('binary-echoed', { size: bytes.byteLength });
  })
  .build();
