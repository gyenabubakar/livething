import { createStore, derive } from '~/client/store.ts';
import { Awareness } from 'y-protocols/awareness';
import type { AwarenessEntry, ChannelAwarenessApi, ChannelStatus } from '@livething/client';
import type { ReadableStore } from '~/client/store.ts';
import type { WireAwareness } from '~/doc/wire.ts';
import type * as Y from 'yjs';

/** A member of an open doc: its connection, its `meta`, and the app's awareness state. */
export interface DocMember<S> {
  readonly connectionId: string;
  readonly meta: Readonly<Record<string, unknown>>;
  /** The app's state, or `null` before it sets one. */
  readonly state: S | null;
}

/** Who holds a lock. */
export interface LockHolder {
  readonly connectionId: string;
  readonly meta: Readonly<Record<string, unknown>>;
}

/** Live state of each member of a doc, typed by the doc's `awareness` schema. */
export interface DocAwareness<S> {
  /** Merge `patch` into this member's state and send it. */
  update(patch: Partial<S>): void;
  /** The other members, by connection ID. A member's other tabs are here too. */
  readonly others: ReadableStore<ReadonlyMap<string, DocMember<S>>>;
  /** This member, as the server holds it, or `null` before it is in the doc. */
  readonly self: ReadableStore<DocMember<S> | null>;
}

/** The parts of a doc's channel the awareness side needs. */
export interface AwarenessRoom {
  readonly awareness: ChannelAwarenessApi<WireAwareness>;
  readonly status: ReadableStore<ChannelStatus>;
}

function member<S>(entry: AwarenessEntry<WireAwareness>): DocMember<S> {
  return {
    connectionId: entry.connectionId,
    meta: entry.meta,
    state: entry.state.user as S | null,
  };
}

function sameLocks(a: ReadonlyMap<string, LockHolder>, b: ReadonlyMap<string, LockHolder>) {
  if (a.size !== b.size) return false;

  for (const [key, holder] of a) if (b.get(key)?.connectionId !== holder.connectionId) return false;

  return true;
}

/**
 * The awareness of one open doc, on the doc's LiveThing channel awareness. Each member's
 * state on the wire holds the app's state, the Yjs client ID, an editor's fields (cursors)
 * and its locks. `yjs()` gives a y-protocols `Awareness` that stays in step with it, for
 * editor bindings.
 */
export function createDocAwareness<S>(
  room: AwarenessRoom,
  ydoc: Y.Doc,
  onError: (error: unknown) => void,
) {
  let mine: WireAwareness = { user: null, yjs: ydoc.clientID, editor: null, locks: [] };
  let attempts: Promise<unknown> = Promise.resolve();

  function joined(): boolean {
    return room.status.get() === 'subscribed';
  }

  function push(): void {
    if (joined()) room.awareness.set(mine);
  }

  const others = derive(room.awareness.others, (entries) => {
    const out = new Map<string, DocMember<S>>();
    for (const [id, entry] of entries) out.set(id, member<S>(entry));

    return out as ReadonlyMap<string, DocMember<S>>;
  });
  const self = derive(room.awareness.self, (entry) => (entry ? member<S>(entry) : null));

  function readLocks(): ReadonlyMap<string, LockHolder> {
    const held = new Map<string, LockHolder>();
    const own = room.awareness.self.get();
    for (const entry of [...room.awareness.others.get().values(), ...(own ? [own] : [])]) {
      for (const key of entry.state.locks) {
        held.set(key, { connectionId: entry.connectionId, meta: entry.meta });
      }
    }

    return held;
  }

  const locks = createStore(readLocks(), onError);
  function refreshLocks() {
    const next = readLocks();
    if (!sameLocks(locks.store.get(), next)) locks.set(next);
  }

  const stops = [
    room.awareness.others.subscribe(refreshLocks),
    room.awareness.self.subscribe(refreshLocks),
    room.status.subscribe((status) => {
      if (status === 'subscribed') push();
    }),
  ];

  /** Ask the server for `key`. Resolves `true` once the server holds it for this member. */
  function attempt(key: string): Promise<boolean> {
    const holder = locks.store.get().get(key);
    const ownId = room.awareness.self.get()?.connectionId;
    if (holder) return Promise.resolve(holder.connectionId === ownId);

    if (!joined()) return Promise.resolve(false);

    mine = { ...mine, locks: [...mine.locks, key] };
    push();

    return new Promise<boolean>((resolve) => {
      const cleanups: (() => void)[] = [];
      function done(taken: boolean) {
        for (const cleanup of cleanups) cleanup();
        if (!taken) mine = { ...mine, locks: mine.locks.filter((each) => each !== key) };
        resolve(taken);
      }

      cleanups.push(
        room.awareness.self.subscribe((entry) => {
          if (entry?.state.locks.includes(key)) done(true);
        }),
        room.awareness.onRefused(() => {
          done(false);
          push();
        }),
        room.status.subscribe((status) => {
          if (status !== 'subscribed') done(false);
        }),
      );
    });
  }

  let bridge: Awareness | null = null;

  /** The y-protocols `Awareness` for editor bindings, made on first use. */
  function yjs(): Awareness {
    if (bridge) return bridge;

    const created = new Awareness(ydoc);
    bridge = created;
    // LiveThing awareness says when a member leaves, so the 30-second timeout must not drop
    // the cursor of a member who is still there but still.
    clearInterval(
      (created as unknown as { _checkInterval: ReturnType<typeof setInterval> })._checkInterval,
    );

    created.on('change', (_changes: unknown, origin: unknown) => {
      if (origin !== 'local') return;

      mine = { ...mine, editor: (created.getLocalState() as WireAwareness['editor']) ?? null };
      push();
    });

    // Each member's editor state as JSON, so a change event goes out only when it changed.
    const copied = new Map<number, string>();

    function copyOthers(entries: ReadonlyMap<string, AwarenessEntry<WireAwareness>>) {
      const seen = new Set<number>();
      const added: number[] = [];
      const updated: number[] = [];
      for (const entry of entries.values()) {
        const { yjs: clientId, editor } = entry.state;
        if (clientId === ydoc.clientID || !editor) continue;

        seen.add(clientId);
        const json = JSON.stringify(editor);
        if (copied.get(clientId) === json) continue;

        (copied.has(clientId) ? updated : added).push(clientId);
        copied.set(clientId, json);
        created.states.set(clientId, editor as Record<string, unknown>);
        const clock = (created.meta.get(clientId)?.clock ?? 0) + 1;
        created.meta.set(clientId, { clock, lastUpdated: Date.now() });
      }

      const removed = [...copied.keys()].filter((clientId) => !seen.has(clientId));
      for (const clientId of removed) {
        copied.delete(clientId);
        created.states.delete(clientId);
        created.meta.delete(clientId);
      }

      if (added.length + updated.length + removed.length === 0) return;

      created.emit('change', [{ added, updated, removed }, 'remote']);
      created.emit('update', [{ added, updated, removed }, 'remote']);
    }

    copyOthers(room.awareness.others.get());
    stops.push(room.awareness.others.subscribe(copyOthers));

    return created;
  }

  return {
    awareness: {
      update(patch) {
        mine = { ...mine, user: { ...(mine.user as object | null), ...patch } };
        push();
      },
      others,
      self,
    } satisfies DocAwareness<S>,
    locks: locks.store,
    lock(key: string): Promise<boolean> {
      const next = attempts.then(() => attempt(key));
      attempts = next.catch(() => {});
      return next;
    },
    unlock(key: string): void {
      // After any lock() still waiting, so a lock() then unlock() ends unlocked.
      attempts = attempts.then(() => {
        if (!mine.locks.includes(key)) return;

        mine = { ...mine, locks: mine.locks.filter((each) => each !== key) };
        push();
      });
    },
    yjs,
    /** The member left the doc: it holds no locks now. */
    left(): void {
      mine = { ...mine, locks: [] };
    },
    destroy(): void {
      for (const stop of stops) stop();
      bridge?.destroy();
    },
  };
}
