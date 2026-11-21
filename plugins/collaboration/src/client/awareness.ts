import { createStore, derive } from '~/client/store.ts';
import { textIndex, textPosition } from '~/doc/anchors.ts';
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

/**
 * Another member's caret in a text field: characters `from` to `to`, the same when nothing
 * is selected. In the input's own units, so `from` and `to` work with `slice()`.
 */
export interface TextCaret<S> {
  readonly member: DocMember<S>;
  readonly from: number;
  readonly to: number;
}

/** The caret `bindText` shares, as relative positions in the editor state. */
interface WireCaret {
  readonly start: Readonly<Record<string, unknown>>;
  readonly end: Readonly<Record<string, unknown>>;
}

/** The editor state field that holds the caret of a bound input. */
const CARET_FIELD = 'textCaret';

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

/** What the awareness of one open doc is built on. */
interface DocAwarenessOptions {
  readonly room: AwarenessRoom;
  /** The socket's connection state: the room still says 'subscribed' while it reconnects. */
  readonly connection: ReadableStore<string>;
  readonly ydoc: Y.Doc;
  readonly onError: (error: unknown) => void;
}

/**
 * The awareness of one open doc, on the doc's LiveThing channel awareness. Each member's
 * state on the wire holds the app's state, the Yjs client ID, an editor's fields (cursors,
 * and the caret of a bound input) and its locks. `yjs()` gives a y-protocols `Awareness` that stays in step with it, for
 * editor bindings.
 */
export function createDocAwareness<S>(options: DocAwarenessOptions) {
  const { room, connection, ydoc, onError } = options;
  let mine: WireAwareness = { user: null, yjs: ydoc.clientID, editor: null, locks: [] };
  let attempts: Promise<unknown> = Promise.resolve();

  function joined(): boolean {
    return room.status.get() === 'subscribed' && connection.get() === 'open';
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

  /**
   * The server freed this member's locks when it left the room; asking again is lock()'s job.
   * LiveThing awareness keeps the state it was last given and sends it when the room is
   * joined again, so it gets the state without locks now, or the new connection would hold
   * the old locks until the next push.
   */
  function dropLocks(): void {
    if (mine.locks.length === 0) return;

    mine = { ...mine, locks: [] };
    const status = room.status.get();
    if (status === 'subscribed' || status === 'subscribing') room.awareness.set(mine);
  }

  // The awareness lives as long as its handle, which lives as long as the socket.
  void [
    room.awareness.others.subscribe(refreshLocks),
    room.awareness.self.subscribe(refreshLocks),
    room.status.subscribe((status) => {
      if (status === 'subscribed') push();
      else dropLocks();
    }),
    connection.subscribe((state) => {
      if (state !== 'open') dropLocks();
    }),
  ];

  /** Ask the server for `key`. Resolves `true` once the server holds it for this member. */
  function attempt(key: string): Promise<boolean> {
    const holder = locks.store.get().get(key);
    const ownId = room.awareness.self.get()?.connectionId;
    if (holder) return Promise.resolve(holder.connectionId === ownId);

    if (!joined()) return Promise.resolve(false);

    mine = { ...mine, locks: [...mine.locks, key] };

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
        connection.subscribe((state) => {
          if (state !== 'open') done(false);
        }),
      );
      // After the listeners: a state too large is refused at once, inside `push()`.
      push();
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
    room.awareness.others.subscribe(copyOthers);

    return created;
  }

  /** The binding whose caret this member shares now: one input at a time has focus. */
  let sharedBy: object | null = null;

  /**
   * Share the caret of the binding `owner` in `text`, or stop sharing it with `null`.
   * Positions follow the characters, so an edit by someone else changes nothing to send.
   */
  function shareCaret(
    owner: object,
    text: Y.Text,
    range: { start: number; end: number } | null,
  ): void {
    // Another binding's caret is the one shown: this one has nothing to clear.
    if (!range && sharedBy !== owner) return;

    let caret: WireCaret | null = null;
    if (range) {
      const start = textPosition(text, range.start, 0);
      caret = { start, end: range.end === range.start ? start : textPosition(text, range.end, -1) };
    }

    // Compared with what the bridge holds: an editor binding may have reset its state.
    const editor = yjs();
    const local = editor.getLocalState();
    const held: unknown = local?.[CARET_FIELD] ?? null;
    if (sharedBy === owner && JSON.stringify(held) === JSON.stringify(caret)) return;

    sharedBy = caret ? owner : null;
    if (local) editor.setLocalStateField(CARET_FIELD, caret);
    else editor.setLocalState({ [CARET_FIELD]: caret });
  }

  /** The other members' carets in `text`. `changes` changes with the doc's content. */
  function carets(
    text: Y.Text,
    changes: ReadableStore<unknown>,
  ): ReadableStore<readonly TextCaret<S>[]> {
    let input: [unknown, unknown] | null = null;
    let output: readonly TextCaret<S>[] = [];

    function read(): readonly TextCaret<S>[] {
      const entries = room.awareness.others.get();
      const change = changes.get();
      if (input && input[0] === entries && input[1] === change) return output;

      input = [entries, change];
      const next: TextCaret<S>[] = [];
      for (const entry of entries.values()) {
        const caret = entry.state.editor?.[CARET_FIELD] as Partial<WireCaret> | null | undefined;
        const from = textIndex(ydoc, caret?.start, text);
        const to = textIndex(ydoc, caret?.end, text);
        if (from === null || to === null) continue;

        next.push({ member: member<S>(entry), from, to: Math.max(from, to) });
      }

      const same =
        next.length === output.length &&
        next.every((caret, index) => {
          const old = output[index]!;
          return (
            caret.from === old.from &&
            caret.to === old.to &&
            caret.member.connectionId === old.member.connectionId &&
            caret.member.state === old.member.state &&
            caret.member.meta === old.member.meta
          );
        });
      if (!same) output = next;

      return output;
    }

    return {
      get: read,
      subscribe(listener) {
        let previous = read();
        function check() {
          const next = read();
          if (next === previous) return;

          previous = next;
          listener(next);
        }

        const stops = [room.awareness.others.subscribe(check), changes.subscribe(check)];
        return () => {
          for (const stop of stops) stop();
        };
      },
    };
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
    shareCaret,
    carets,
    /** The member left the doc: it holds no locks now. */
    left(): void {
      dropLocks();
    },
  };
}
