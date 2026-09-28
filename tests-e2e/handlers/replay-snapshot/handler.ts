import { emits, server, t } from '@livething/server';
import { channels } from '@livething/server/channels';
import { dedup } from '@livething/server/dedup';
import { Disconnect } from '@livething/server/errors';
import { replay } from '@livething/server/replay';
import { sequence } from '@livething/server/sequence';
import * as v from 'valibot';
import type { InferClient } from '@livething/server';
import type { ReplaySnapshotValue } from '@livething/server/replay';
import { requireUsername } from '../_shared/upgrade.ts';
import { BurstCounter, DeleteDoc, IncrementCounter, RoomUpdateDoc, UpdateDoc } from './events.ts';
import type {
  BurstDone,
  CounterSnapshot,
  DocDeleted,
  DocSnapshot,
  RoomDocSnapshot,
} from './events.ts';

function reduceSnapshot(
  previous: ReplaySnapshotValue | null,
  next: ReplaySnapshotValue,
): ReplaySnapshotValue | null {
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

const base = server({
  upgrade: (request) => requireUsername(request),
  capabilities: [
    emits({
      'doc-snapshot': t<v.InferOutput<typeof DocSnapshot>>(),
      'doc-deleted': t<v.InferOutput<typeof DocDeleted>>(),
      'counter-snapshot': t<v.InferOutput<typeof CounterSnapshot>>(),
      'burst-done': t<v.InferOutput<typeof BurstDone>>(),
    }),
    dedup(),
    sequence({ persist: true }),
    replay.snapshot({
      snapshotKey: (_event, payload) => String(payload.docId ?? payload.key),
      reduce: reduceSnapshot,
      retention: { maxMessages: 5, maxAgeMs: 1_000 },
      durability: 'best-effort',
    }),
    channels(),
  ],
});

base.onError((_ctx, error, event) => {
  console.error(`[replay-snapshot] error in ${event}:`, error);
});

export const handleUpdateDoc = base.on('update-doc', {
  input: UpdateDoc,
  run(ctx, payload) {
    ctx.broadcast(
      'doc-snapshot',
      { docId: payload.docId, title: payload.title },
      { includeSelf: true },
    );
  },
});

export const handleDeleteDoc = base.on('delete-doc', {
  input: DeleteDoc,
  run(ctx, payload) {
    ctx.broadcast('doc-deleted', { docId: payload.docId }, { includeSelf: true });
  },
});

export const handleIncrementCounter = base.on('increment-counter', {
  input: IncrementCounter,
  run(ctx, payload) {
    ctx.broadcast(
      'counter-snapshot',
      { key: payload.key, total: payload.amount },
      { includeSelf: true },
    );
  },
});

// Burst handler used for the snapshot-coalescing benchmark. It sends many
// counter snapshots for one key in a single handler run; they fold in memory
// and produce one SQL write when the handler finishes.
export const handleBurstCounter = base.on('burst-counter', {
  input: BurstCounter,
  run(ctx, payload) {
    for (let i = 0; i < payload.count; i += 1) {
      ctx.broadcast('counter-snapshot', { key: payload.key, total: 1 }, { includeSelf: true });
    }

    ctx.send('burst-done', { key: payload.key, sent: payload.count });
  },
});

// Test support: lets a client trigger a server-initiated close with a
// retryable code so the client reconnects in-session and replay() fires.
export const handleServerDrop = base.on('server-drop', {
  input: v.object({}),
  run() {
    throw Disconnect(4500, 'test drop');
  },
});

const snapshotRoom = base.channel('snapshot-room', {
  capabilities: [
    emits({
      'room-doc-snapshot': t<v.InferOutput<typeof RoomDocSnapshot>>(),
    }),
  ],
});

export const handleUpdateRoomDoc = snapshotRoom.on('update-room-doc', {
  input: RoomUpdateDoc,
  run(ctx, payload) {
    ctx.channel.broadcast(
      'room-doc-snapshot',
      { docId: payload.docId, title: payload.title },
      { includeSelf: true },
    );
  },
});

export const replaySnapshotDefinition = base.assemble({
  handlers: [
    handleUpdateDoc,
    handleDeleteDoc,
    handleIncrementCounter,
    handleBurstCounter,
    handleServerDrop,
    handleUpdateRoomDoc,
  ],
});

export type ReplaySnapshotClient = InferClient<typeof replaySnapshotDefinition>;
