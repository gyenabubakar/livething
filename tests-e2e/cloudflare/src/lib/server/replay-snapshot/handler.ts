import { channel, contract, implement, incoming, outgoing, t } from '@wskit/server';
import { RejectUpgrade } from '@wskit/server/errors';
import type { InferClient } from '@wskit/server';
import {
  BurstCounter,
  BurstDone,
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

export const replaySnapshotContract = contract('replay-snapshot-test', {
  env: t<Env>(),
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
    incoming('burst-counter', BurstCounter),

    outgoing('doc-snapshot', DocSnapshot),
    outgoing('doc-deleted', DocDeleted),
    outgoing('counter-snapshot', CounterSnapshot),
    outgoing('burst-done', BurstDone),

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
  // Burst handler used for the snapshot-coalescing benchmark. It sends a
  // pile of counter-snapshot messages in one go, all targeting the same
  // snapshot key. Before the snapshot-batching change, each send hit SQL
  // and wrote a row that the next send overwrote anyway — `count` writes
  // for one final row. After the change, all the sends fold together in
  // memory inside the open handler scope and one row gets written when
  // the handler finishes.
  .on('burst-counter', (ctx, payload) => {
    for (let i = 0; i < payload.count; i += 1) {
      ctx.send('counter-snapshot', { key: payload.key, total: 1 });
    }
    ctx.send('burst-done', { key: payload.key, sent: payload.count });
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
