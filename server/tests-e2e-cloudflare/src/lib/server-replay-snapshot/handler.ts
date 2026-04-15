import { server } from '@wskit/server';
import { withDedup } from '@wskit/server/dedup';
import { RejectUpgrade } from '@wskit/server/errors';
import { withLifecycle } from '@wskit/server/lifecycle';
import { withReplay } from '@wskit/server/replay';
import { withSequence } from '@wskit/server/sequence';
import type { InferClient } from '@wskit/server';
import { DocSnapshot, UpdateDoc } from './events.ts';

export const replaySnapshotHandler = withReplay(
  withLifecycle(withSequence(withDedup(server<Env>('replay-snapshot-test')))),
)
  .sequence({ persist: true })
  .dedup()
  .outgoing(DocSnapshot)
  .replay('snapshot', (r) =>
    r
      .snapshotKey((_ev, p) => String(p.docId))
      .retention({ maxMessages: 5 })
      .durability('best-effort'),
  )
  .onError((_ctx, error, event) => {
    console.error(`[replay-snapshot] error in ${event}:`, error);
  })
  .onUpgrade((request) => {
    const url = new URL(request.url);
    const username = url.searchParams.get('username');
    if (!username) throw RejectUpgrade(4001, 'Missing username');
    return { meta: { username } };
  })
  .incoming(UpdateDoc, (ctx, payload) => {
    ctx.send('doc-snapshot', { docId: payload.docId, title: payload.title });
    ctx.broadcast('doc-snapshot', { docId: payload.docId, title: payload.title });
  })
  .build();

export type ReplaySnapshotClient = InferClient<typeof replaySnapshotHandler>;
