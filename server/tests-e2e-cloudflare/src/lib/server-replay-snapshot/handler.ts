import { server } from '@wskit/server';
import { withChannels } from '@wskit/server/channels';
import { withDedup } from '@wskit/server/dedup';
import { RejectUpgrade } from '@wskit/server/errors';
import { withLifecycle } from '@wskit/server/lifecycle';
import { withReplay } from '@wskit/server/replay';
import { withSequence } from '@wskit/server/sequence';
import type { InferClient } from '@wskit/server';
import {
  CounterSnapshot,
  DeleteDoc,
  DocDeleted,
  DocSnapshot,
  IncrementCounter,
  RoomDocSnapshot,
  RoomUpdateDoc,
  UpdateDoc,
} from './events.ts';

const base = withChannels(
  withReplay(withLifecycle(withSequence(withDedup(server<Env>('replay-snapshot-test'))))),
);

function reduceSnapshot(
  previous: { event: string; payload: Record<string, unknown> } | null,
  next: { event: string; payload: Record<string, unknown> },
) {
  if (next.event === 'doc-deleted') return null;
  if (next.event !== 'counter-snapshot') return next;

  const previousTotal = previous?.event === 'counter-snapshot' ? Number(previous.payload.total) : 0;
  return {
    event: next.event,
    payload: {
      ...next.payload,
      total: previousTotal + Number(next.payload.total),
    },
  };
}

export const replaySnapshotHandler = base
  .sequence({ persist: true })
  .dedup()
  .outgoing(DocSnapshot)
  .outgoing(DocDeleted)
  .outgoing(CounterSnapshot)
  .replay('snapshot', (r) =>
    r
      .snapshotKey((_ev, p) => String(p.docId ?? p.key))
      .reduce(reduceSnapshot)
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
  .incoming(DeleteDoc, (ctx, payload) => {
    ctx.send('doc-deleted', { docId: payload.docId });
    ctx.broadcast('doc-deleted', { docId: payload.docId });
  })
  .incoming(IncrementCounter, (ctx, payload) => {
    ctx.send('counter-snapshot', { key: payload.key, total: payload.amount });
  })
  .use(
    base.channel('snapshot-room', (ch) =>
      ch
        .outgoing(RoomDocSnapshot)
        .replay('snapshot', (r) => r.snapshotKey((_event, payload) => String(payload.docId)))
        .incoming(RoomUpdateDoc, (ctx, payload) => {
          ctx.channel.send('room-doc-snapshot', { docId: payload.docId, title: payload.title });
          ctx.channel.broadcast('room-doc-snapshot', {
            docId: payload.docId,
            title: payload.title,
          });
        }),
    ),
  )
  .build();

export type ReplaySnapshotClient = InferClient<typeof replaySnapshotHandler>;
