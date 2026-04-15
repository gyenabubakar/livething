import { server } from '@wskit/server';
import { withDedup } from '@wskit/server/dedup';
import { RejectUpgrade } from '@wskit/server/errors';
import { withLifecycle } from '@wskit/server/lifecycle';
import { withReplay } from '@wskit/server/replay';
import { withSequence } from '@wskit/server/sequence';
import type { InferClient } from '@wskit/server';
import { CounterSnapshot, DocSnapshot, IncrementCounter, UpdateDoc } from './events.ts';

export const replaySnapshotHandler = withReplay(
  withLifecycle(withSequence(withDedup(server<Env>('replay-snapshot-test')))),
)
  .sequence({ persist: true })
  .dedup()
  .outgoing(DocSnapshot)
  .outgoing(CounterSnapshot)
  .replay('snapshot', (r) =>
    r
      .snapshotKey((_ev, p) => String(p.docId ?? p.key))
      .reduce((prev, next) => {
        if (next.event !== 'counter-snapshot') return next;
        const prevTotal = prev?.event === 'counter-snapshot' ? (prev.payload.total as number) : 0;
        return {
          event: next.event,
          payload: { ...next.payload, total: prevTotal + (next.payload.total as number) },
        };
      })
      .retention({ maxMessages: 5, maxAgeMs: 2000 })
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
  .incoming(IncrementCounter, (ctx, payload) => {
    ctx.send('counter-snapshot', { key: payload.key, total: payload.amount });
    ctx.broadcast('counter-snapshot', { key: payload.key, total: payload.amount });
  })
  .build();

export type ReplaySnapshotClient = InferClient<typeof replaySnapshotHandler>;
