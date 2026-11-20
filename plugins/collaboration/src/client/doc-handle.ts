import { decodeBase64, LiveThingError } from '@livething/core';
import { createDocAwareness } from '~/client/awareness.ts';
import { bindText } from '~/client/bind-text.ts';
import { createDocState } from '~/client/doc-state.ts';
import { createStore } from '~/client/store.ts';
import { DocCore } from '~/doc/core.ts';
import { eachPart, joinBytes } from '~/doc/parts.ts';
import { OUT_OF_ORDER } from '~/doc/wire.ts';
import * as Y from 'yjs';
import type { AwarenessRoom, DocAwareness, LockHolder } from '~/client/awareness.ts';
import type { TextInput } from '~/client/bind-text.ts';
import type { DocState } from '~/client/doc-state.ts';
import type { ReadableStore } from '~/client/store.ts';
import type { CollaborationStorage, DocRef } from '~/doc/storage.ts';
import type { Access, RefusedInfo, ServerUpdateInfo, SyncInfo, UpdateInfo } from '~/doc/wire.ts';
import type { DocDef, PathOf, YRef } from '~/schema.ts';
import type { Awareness } from 'y-protocols/awareness';

/** Updates the plugin applies itself, from the server or the device. They are not sent back. */
const FROM_SERVER = Symbol('livething.collaboration.server');
const FROM_DEVICE = Symbol('livething.collaboration.device');

/** Compact a doc's updates on the device into one after this many. */
const COMPACT_AFTER_UPDATES = 200;

/** Where a doc is: not open, joining, in step with the server, sending changes, or offline. */
export type DocStatus = 'closed' | 'opening' | 'synced' | 'saving' | 'offline';

/** The server undid one of this client's changes. */
export interface Refusal {
  readonly reason: string;
}

/** What a `ReadOnly` error says: which doc can only be read. */
export interface ReadOnlyDetail {
  readonly type: string;
  readonly id: string;
}

/** The parts of a doc's LiveThing channel the handle uses. */
export interface DocRoom extends AwarenessRoom {
  subscribe(): Promise<void>;
  unsubscribe(): Promise<void>;
  onSubscribed(callback: () => void): () => void;
  readonly binary: {
    send(event: 'update', bytes: Uint8Array, options: { info: UpdateInfo }): boolean;
    request(
      event: 'sync',
      bytes: Uint8Array,
      options: { info: null },
    ): Promise<{ info: SyncInfo; bytes: Uint8Array }>;
    on(event: 'update', handler: (info: ServerUpdateInfo, bytes: Uint8Array) => void): () => void;
    on(event: 'ack', handler: (info: { n: number }) => void): () => void;
    on(event: 'refused', handler: (info: RefusedInfo, bytes: Uint8Array) => void): () => void;
  };
}

type Picker<D extends DocDef, T> = (path: PathOf<D['shape']>) => T | undefined;
type AwarenessOf<D extends DocDef> = D extends { awareness?: infer S } ? NonNullable<S> : never;
type AwarenessState<D extends DocDef> =
  AwarenessOf<D> extends { '~standard': { types?: { output: infer O } } }
    ? O
    : Record<string, never>;

/**
 * One doc on the client: `collab.doc(type, id)`. `open()` joins it, `change()` edits it,
 * and the stores show its content, its members and where it is.
 */
export interface DocHandle<D extends DocDef> extends Omit<DocState<D>, 'destroy' | 'yjs'> {
  readonly type: D['name'];
  readonly id: string;
  /** Join the doc and sync it. Counted: each `open()` needs a `close()`. */
  open(): Promise<void>;
  /** Leave the doc, a moment after the last `close()`. */
  close(): void;
  readonly status: ReadableStore<DocStatus>;
  /** `'edit'` or `'view'` once open, else `null`. */
  readonly access: ReadableStore<Access | null>;
  /** Run `callback` when the server undoes one of this client's changes. */
  onRefused(callback: (refusal: Refusal) => void): () => void;
  readonly awareness: DocAwareness<AwarenessState<D>>;
  /** Hold `key` so only this member edits that part. Resolves `false` when someone else has it. */
  lock(key: string): Promise<boolean>;
  unlock(key: string): void;
  /** Every lock held, by key. */
  readonly locks: ReadableStore<ReadonlyMap<string, LockHolder>>;
  /** Keep a text input and a `text()` field in step, with the cursor where it was. */
  bindText(input: TextInput, pick: Picker<D, YRef<Y.Text>>): () => void;
  /** The raw Yjs objects, for rich text editors. */
  readonly yjs: DocState<D>['yjs'] & { readonly awareness: Awareness };
}

export interface DocHandleOptions<D extends DocDef> {
  readonly def: D;
  readonly ref: DocRef;
  readonly room: DocRoom;
  /** The socket's connection state. */
  readonly connection: ReadableStore<string>;
  readonly storage: CollaborationStorage | undefined;
  readonly closeDelayMs: number;
  readonly onError: (error: unknown) => void;
}

/** The promise `open()` gives, with the functions that settle it. */
interface Opening {
  readonly promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
}

function newOpening(): Opening {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  // It can fail before `open()` hands it out (a close during the device load); each caller
  // still gets the rejection.
  promise.catch(() => {});

  return { promise, resolve, reject };
}

function isEmpty(update: Uint8Array): boolean {
  // An update with no changes and no deletes.
  return update.length <= 2;
}

export function createDocHandle<D extends DocDef>(options: DocHandleOptions<D>): DocHandle<D> {
  const { def, ref, room, storage, onError } = options;
  const ydoc = new Y.Doc();
  const core = new DocCore(def, ydoc);
  const docState = createDocState(core, onError);
  const aware = createDocAwareness<AwarenessState<D>>(room, ydoc, onError);

  const status = createStore<DocStatus>('closed', onError);
  const access = createStore<Access | null>(null, onError);
  const refusals = new Set<(refusal: Refusal) => void>();

  let opens = 0;
  let active = false;
  let lingering: ReturnType<typeof setTimeout> | null = null;
  let loaded: Promise<void> | null = null;
  /** What every `open()` waits for, until the first sync after it. */
  let opening: Opening | null = null;

  let synced = false;
  let everSynced = false;
  let syncs = 0;
  let sent = 0;
  const pending = new Set<number>();

  let incoming: Uint8Array[] = [];

  let deviceWrites: Promise<void> = Promise.resolve();
  let deviceAppends = 0;

  function setStatus(): void {
    if (!active) status.set('closed');
    else if (!synced) status.set(everSynced ? 'offline' : 'opening');
    else status.set(pending.size > 0 ? 'saving' : 'synced');
  }

  function keepOnDevice(update: Uint8Array): void {
    if (!storage) return;

    deviceWrites = deviceWrites
      .then(async () => {
        deviceAppends += 1;
        if (deviceAppends >= COMPACT_AFTER_UPDATES) {
          await storage.compact(ref, Y.encodeStateAsUpdate(ydoc));
          deviceAppends = 1;
        } else {
          await storage.append(ref, update);
        }
      })
      .catch(onError);
  }

  function send(update: Uint8Array): void {
    sent += 1;
    const n = sent;
    pending.add(n);
    eachPart(update, (bytes, part) => {
      room.binary.send('update', bytes, { info: part ? { n, part } : { n } });
    });
    setStatus();
  }

  ydoc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin === FROM_DEVICE) return;

    keepOnDevice(update);
    // Before the first sync, or offline, the sync after the next join sends it.
    if (origin !== FROM_SERVER && synced && access.store.get() === 'edit') send(update);
  });

  /** The connection or the room dropped: the next join syncs again. */
  function unsync(): void {
    if (!synced) return;

    synced = false;
    pending.clear();
    setStatus();
  }

  async function sync(): Promise<void> {
    syncs += 1;
    const generation = syncs;
    synced = false;
    pending.clear();
    incoming = [];

    setStatus();

    let info: SyncInfo;
    try {
      ({ info } = await room.binary.request('sync', Y.encodeStateVector(ydoc), { info: null }));
    } catch (error) {
      if (generation !== syncs) return;

      // The first sync failed: `open()` fails, and the doc closes. A later one: report it,
      // and the next join syncs again.
      if (opening) stop(error);
      else onError(error);
      return;
    }

    if (generation !== syncs || !active) return;

    access.set(info.access);
    synced = true;
    everSynced = true;
    // Everything the server lacks: edits made offline, or before this sync answered.
    const missing = Y.encodeStateAsUpdate(ydoc, decodeBase64(info.vector) ?? undefined);
    if (info.access === 'edit' && !isEmpty(missing)) send(missing);

    setStatus();
    opening?.resolve();
    opening = null;
  }

  // The handle lives as long as the socket's plugin, so these listeners are never removed.
  void [
    room.onSubscribed(() => {
      if (active) void sync();
    }),
    room.status.subscribe((state) => {
      if (state !== 'subscribed') unsync();
    }),
    options.connection.subscribe((state) => {
      if (state !== 'open') unsync();
    }),
    room.binary.on('update', (info, bytes) => {
      incoming.push(bytes.slice());
      if (info && info.part[0] < info.part[1] - 1) return;

      const update = joinBytes(incoming);
      incoming = [];
      try {
        Y.applyUpdate(ydoc, update, FROM_SERVER);
      } catch (error) {
        onError(error);
      }
    }),
    room.binary.on('ack', (info) => {
      pending.delete(info.n);
      setStatus();
    }),
    room.binary.on('refused', (info, bytes) => {
      pending.delete(info.n);
      if (bytes.length > 0) Y.applyUpdate(ydoc, bytes, FROM_SERVER);

      // An earlier update was lost on the way: send everything the server lacks.
      if (info.reason === OUT_OF_ORDER) void sync();

      for (const callback of [...refusals]) {
        try {
          callback({ reason: info.reason });
        } catch (error) {
          onError(error);
        }
      }

      setStatus();
    }),
  ];

  /** Apply what the device holds, once. A failed load is tried again on the next open. */
  function loadFromDevice(): Promise<void> {
    loaded ??= (async () => {
      if (!storage) return;

      const updates = await storage.load(ref);
      deviceAppends = updates.length;
      Y.transact(
        ydoc,
        () => {
          for (const update of updates) Y.applyUpdate(ydoc, update, FROM_DEVICE);
        },
        FROM_DEVICE,
      );
    })();
    loaded.catch(() => {
      loaded = null;
    });

    return loaded;
  }

  /** Close the doc now: every `open()` still waiting gets `error`, and no open stays counted. */
  function stop(error: unknown): void {
    if (lingering) clearTimeout(lingering);

    lingering = null;
    opens = 0;
    active = false;

    synced = false;
    // The next open() shows 'opening', not 'offline'.
    everSynced = false;
    syncs += 1;
    pending.clear();

    access.set(null);
    aware.left();
    setStatus();
    room.unsubscribe().catch(() => {});

    opening?.reject(error);
    opening = null;
  }

  function leave(): void {
    stop(new Error(`the doc ${ref.type}:${ref.id} was closed before it was synced`));
  }

  const handle: DocHandle<D> = {
    type: def.name,
    id: ref.id,
    open() {
      opens += 1;
      if (lingering) {
        clearTimeout(lingering);
        lingering = null;
      }

      if (active) return opening?.promise ?? Promise.resolve();

      active = true;
      const current = newOpening();
      opening = current;
      setStatus();

      void (async () => {
        try {
          await loadFromDevice();
          // Closed while the device loaded: do not join.
          if (opening !== current) return;

          const syncsBefore = syncs;
          await room.subscribe();
          if (opening !== current) {
            // Closed while joining: leave again, unless a new open() is using the room.
            if (!active) room.unsubscribe().catch(() => {});
            return;
          }

          // Joined with no `onSubscribed` (the room was still joined): sync here.
          if (!synced && syncs === syncsBefore) void sync();
        } catch (error) {
          if (opening === current) stop(error);
        }
      })();

      return current.promise;
    },
    close() {
      if (opens === 0) return;

      opens -= 1;
      if (opens > 0 || !active) return;

      lingering = setTimeout(leave, options.closeDelayMs);
    },
    status: status.store,
    access: access.store,
    onRefused(callback) {
      refusals.add(callback);
      return () => {
        refusals.delete(callback);
      };
    },
    state: docState.state,
    select: docState.select,
    change(mutate) {
      if (access.store.get() === 'view') {
        throw new LiveThingError<'read-only', ReadOnlyDetail>('read-only', {
          type: ref.type,
          id: ref.id,
        });
      }

      return docState.change(mutate);
    },
    keyOf: docState.keyOf,
    history: docState.history,
    anchor: docState.anchor,
    awareness: aware.awareness,
    lock: aware.lock,
    unlock: aware.unlock,
    locks: aware.locks,
    bindText(input, pick) {
      return bindText(input, docState.yjs.at(pick), handle);
    },
    yjs: {
      doc: ydoc,
      at: docState.yjs.at,
      get awareness() {
        return aware.yjs();
      },
    },
  };

  return handle;
}
