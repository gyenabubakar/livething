import { channel, contract, implement, incoming, outgoing, t } from '@wskit/server';
import { RejectUpgrade } from '@wskit/server/errors';
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

export const replaySnapshotContract = contract<Env>('replay-snapshot-test')({
  sequence: { persist: true },
  dedup: true,
  replay: {
    type: 'snapshot',
    snapshotKey: (_ev, p) => String(p.docId ?? p.key),
    reduce: reduceSnapshot,
    retention: { maxMessages: 5, maxAgeMs: 1_000 },
    durability: 'best-effort',
  },
  meta: t<{ username: string }>(),
  definitions: [
    incoming('update-doc', UpdateDoc),
    incoming('delete-doc', DeleteDoc),
    incoming('increment-counter', IncrementCounter),

    outgoing('doc-snapshot', DocSnapshot),
    outgoing('doc-deleted', DocDeleted),
    outgoing('counter-snapshot', CounterSnapshot),

    channel('snapshot-room', {
      replay: {
        type: 'snapshot',
        snapshotKey: (_event: string, payload: Record<string, unknown>) => String(payload.docId),
      },
      definitions: [
        outgoing('room-doc-snapshot', RoomDocSnapshot),
        incoming('update-room-doc', RoomUpdateDoc),
      ],
    }),
  ],
});

export const replaySnapshotHandler = implement(replaySnapshotContract)
  .onError((_ctx, error, event) => {
    console.error(`[replay-snapshot] error in ${event}:`, error);
  })
  .onUpgrade((request) => {
    const url = new URL(request.url);
    const username = url.searchParams.get('username');
    if (!username) throw RejectUpgrade(4001, 'Missing username');
    return { identity: username, meta: { username } };
  })
  .on('update-doc', (ctx, payload) => {
    ctx.send('doc-snapshot', { docId: payload.docId, title: payload.title });
    ctx.broadcast('doc-snapshot', { docId: payload.docId, title: payload.title });
  })
  .on('delete-doc', (ctx, payload) => {
    ctx.send('doc-deleted', { docId: payload.docId });
    ctx.broadcast('doc-deleted', { docId: payload.docId });
  })
  .on('increment-counter', (ctx, payload) => {
    ctx.send('counter-snapshot', { key: payload.key, total: payload.amount });
  })
  .channel('snapshot-room', (ch) =>
    ch.on('update-room-doc', (ctx, payload) => {
      ctx.channel.send('room-doc-snapshot', { docId: payload.docId, title: payload.title });
      ctx.channel.broadcast('room-doc-snapshot', {
        docId: payload.docId,
        title: payload.title,
      });
    }),
  )
  .build();

export type ReplaySnapshotClient = InferClient<typeof replaySnapshotHandler>;
