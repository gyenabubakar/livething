import { decodeBase64, LiveThingError } from '@livething/core';
import { createDocAwareness } from '~/client/awareness.ts';
import { bindText } from '~/client/bind-text.ts';
import { createDocState } from '~/client/doc-state.ts';
import { createStore } from '~/client/store.ts';
import { DocCore } from '~/doc/core.ts';
import { eachPart, joinBytes } from '~/doc/parts.ts';
import { checkVersion, restoreFrom } from '~/doc/restore.ts';
import { MAX_UPDATE_BYTES, OUT_OF_ORDER } from '~/doc/wire.ts';
import * as Y from 'yjs';
import type { AwarenessRoom, DocAwareness, LockHolder } from '~/client/awareness.ts';
import type { TextInput } from '~/client/bind-text.ts';
import type { DocState } from '~/client/doc-state.ts';
import type { ReadableStore } from '~/client/store.ts';
import type { CollaborationStorage, DocRef } from '~/doc/storage.ts';
import type {
  Access,
  ReadVersionInfo,
  RefusedInfo,
  ServerUpdateInfo,
  SyncInfo,
  UpdateInfo,
  VersionInfo,
  VersionPartInfo,
} from '~/doc/wire.ts';
import type { DocDef, PathOf, Snapshot, YRef } from '~/schema.ts';
import type { Awareness } from 'y-protocols/awareness';

/** Updates the plugin applies itself, from the server or the device. They are not sent back. */
const FROM_SERVER = Symbol('livething.collaboration.server');
const FROM_DEVICE = Symbol('livething.collaboration.device');

/** Compact a doc's updates on the device into one after this many. */
const COMPACT_AFTER_UPDATES = 200;

/** Where a doc is: not open, joining, in step with the server, sending changes, or offline. */
export type DocStatus = 'closed' | 'opening' | 'synced' | 'saving' | 'offline';

/** The server undid one of this client's changes. `onRefused` gets it. */
export interface Refusal {
  /** Why, in words, such as `'this client may only view the doc'`. For logs, not for users. */
  readonly reason: string;
}

/**
 * The detail of the `read-only` error that `change()` and `versions.restore()` throw in a
 * doc this client may only view: which doc.
 */
export interface ReadOnlyDetail {
  readonly type: string;
  readonly id: string;
}

/**
 * The detail of the `update-not-sent` error that `onError` gets when the client can't send a
 * change: which doc, and why.
 */
export interface UpdateNotSentDetail {
  readonly type: string;
  readonly id: string;
  readonly reason: string;
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
    on(event: 'version', handler: (info: VersionPartInfo, bytes: Uint8Array) => void): () => void;
    request(
      event: 'read-version',
      bytes: Uint8Array,
      options: { info: ReadVersionInfo },
    ): Promise<{ info: null; bytes: Uint8Array }>;
  };
  request(event: 'save-version', payload: { label: string }): Promise<VersionInfo>;
  request(event: 'list-versions', payload: null): Promise<{ versions: readonly VersionInfo[] }>;
  request(event: 'delete-version', payload: { id: string }): Promise<null>;
}

/**
 * A doc's saved versions, kept on the server. The doc must be open.
 *
 * @example
 * ```ts
 * await board.versions.save('Before the launch review')
 * const [latest] = await board.versions.list()
 * if (latest) await board.versions.restore(latest.id)
 * ```
 */
export interface DocVersions<D extends DocDef> {
  /**
   * Save the doc as the server has it now, after the server confirmed the changes this
   * client sent. Needs `'edit'` access.
   *
   * @param label 1 to 200 characters, such as `'Before the launch review'`.
   * @returns The new version's info. Its `author` is this client's user ID.
   * @throws `access-denied` for a `'view'` client, and `validation-failed` for a bad label.
   */
  save(label: string): Promise<VersionInfo>;
  /** The doc's versions, newest first. */
  list(): Promise<readonly VersionInfo[]>;
  /**
   * One version's content, typed like `state`.
   *
   * @throws `version-not-found` when the doc has no version with that ID.
   */
  read(id: string): Promise<Snapshot<D['shape']>>;
  /**
   * Make the doc hold what a version holds. It changes only what differs, as one `change()`:
   * every member gets it, and `history.undo()` takes it back. Text keeps its anchors on the
   * words that did not change, and list items that are still there keep their IDs.
   *
   * @throws `read-only` for a `'view'` client, `version-not-found` for an unknown ID, and
   * `invalid-change` for a version the doc type's schema now refuses.
   */
  restore(id: string): Promise<void>;
  /**
   * Delete a version from the server. The doc and its other versions stay as they are.
   * Needs `'edit'` access.
   *
   * @throws `access-denied` for a `'view'` client, and `version-not-found` for an unknown ID.
   */
  delete(id: string): Promise<void>;
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
export interface DocHandle<D extends DocDef> extends Omit<DocState<D>, 'yjs'> {
  /** The doc type's name, such as `'task-board'`. */
  readonly type: D['name'];
  /** The doc's ID within its type, such as `'launch'`. */
  readonly id: string;
  /**
   * Join the doc: load what the device keeps (with the `storage` option), join the doc's
   * room, and sync, where each side sends only what the other is missing. Resolves once
   * the doc is synced.
   *
   * Counted: each `open()` needs a `close()`, a failed one too, and calls while it is open
   * resolve with the same sync. Rejects with the server's error (such as `access-denied` when `access`
   * returned `false`), or when the doc is closed before it synced.
   */
  open(): Promise<void>;
  /**
   * Undo one `open()`. After the last one, the doc stays joined for `closeDelayMs`, so a
   * quick unmount and mount (React StrictMode) does not leave and join again. Then it leaves
   * the room and frees this member's locks. The content stays in memory.
   */
  close(): void;
  /**
   * Where the doc is: `'closed'`, `'opening'` (joining for the first time), `'synced'`,
   * `'saving'` (the server has not confirmed some of this client's changes yet), or
   * `'offline'` (the socket or the room dropped; changes wait and go out on the next join).
   */
  readonly status: ReadableStore<DocStatus>;
  /** What the server's `access` gave this client: `'edit'` or `'view'` once open, else `null`. */
  readonly access: ReadableStore<Access | null>;
  /**
   * Run `callback` when the server undoes one of this client's changes, such as a value its
   * schema refuses (from an older app version). The doc already shows the undone state.
   * It also runs each time the client joins as a `'view'` client with content the server does
   * not have: changes made offline or kept in device storage, or content the server lost. That
   * content is not sent, and stays in this client's copy (and its device storage).
   * Returns a function that removes the callback.
   */
  onRefused(callback: (refusal: Refusal) => void): () => void;
  /** Each member's live state, typed by the doc's `awareness` schema. */
  readonly awareness: DocAwareness<AwarenessState<D>>;
  /**
   * Hold `key` so only this member edits that part, such as `'task:t_1042'`. Resolves `true`
   * once the server holds it for this member, and `false` when another member has it, the
   * client may only view, the doc is not open, or the socket is down. A lock is freed by
   * `unlock()`, `close()` or a disconnect; after a reconnect, call `lock()` again. A member
   * holds at most 32 locks, each key at most 128 bytes when written as JSON.
   *
   * @example
   * ```ts
   * if (await board.lock('task:t_1042')) openEditor()
   * else showToast('Someone else is editing this task.')
   * ```
   */
  lock(key: string): Promise<boolean>;
  /** Free a lock this member holds. Runs after any `lock()` still waiting for the server. */
  unlock(key: string): void;
  /** Every lock held in the doc, by key, with who holds it. */
  readonly locks: ReadableStore<ReadonlyMap<string, LockHolder>>;
  /**
   * Keep an `<input>` or `<textarea>` and a `text()` field in step. Typing becomes changes,
   * and when someone else edits the text, the input updates and the cursor stays on the
   * same character. Returns a function that unbinds it.
   *
   * @example
   * ```ts
   * const unbind = board.bindText(titleInput, (p) => p.tasks[0]?.title)
   * ```
   */
  bindText(input: TextInput, pick: Picker<D, YRef<Y.Text>>): () => void;
  /**
   * The raw Yjs objects, for editor bindings: the `Y.Doc`, the typed Yjs type at a path
   * (`at()`), and a y-protocols `Awareness` that stays in step with LiveThing awareness, for
   * remote cursors.
   *
   * @example
   * ```ts
   * import { ySyncPlugin, yCursorPlugin, yUndoPlugin } from 'y-prosemirror'
   *
   * const notes = board.yjs.at((p) => p.tasks[0]?.notes) // Y.XmlFragment
   * const plugins = [ySyncPlugin(notes), yCursorPlugin(board.yjs.awareness), yUndoPlugin()]
   * ```
   */
  readonly yjs: DocState<D>['yjs'] & { readonly awareness: Awareness };
  /** The doc's saved versions, kept on the server. */
  readonly versions: DocVersions<D>;
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
  const aware = createDocAwareness<AwarenessState<D>>({
    room,
    connection: options.connection,
    ydoc,
    onError,
  });

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
  /** A local change happened that the next sync must send. */
  let unsent = false;

  let incoming: Uint8Array[] = [];
  /** The `version` parts of each version read in flight, by its `n`. */
  const versionParts = new Map<number, Uint8Array[]>();
  let reads = 0;

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

  function notSent(reason: string): void {
    onError(
      new LiveThingError<'update-not-sent', UpdateNotSentDetail>('update-not-sent', {
        type: ref.type,
        id: ref.id,
        reason,
      }),
    );
  }

  /**
   * Send an update. One the socket can't send is not left waiting for an ack. While the socket
   * is down, the sync after the reconnect sends it. While it is open, the socket will never
   * send it, so `onError` hears of it.
   */
  function send(update: Uint8Array): void {
    if (update.length > MAX_UPDATE_BYTES) {
      notSent(`the update is ${update.length} bytes, over the limit of ${MAX_UPDATE_BYTES}`);
      return;
    }

    sent += 1;
    const n = sent;
    pending.add(n);
    let dropped = false;
    eachPart(update, (bytes, part) => {
      dropped ||= !room.binary.send('update', bytes, { info: part ? { n, part } : { n } });
    });

    if (dropped) {
      pending.delete(n);
      if (options.connection.get() === 'open') {
        notSent('the open socket dropped it, as it drops a message over binary({ maxFrameBytes })');
      }
    }

    setStatus();
  }

  ydoc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin === FROM_DEVICE) return;

    keepOnDevice(update);
    if (origin === FROM_SERVER) return;

    if (synced && access.store.get() === 'edit') send(update);
    // Before the first sync, or offline, the sync after the next join sends it.
    else unsent = true;
  });

  /**
   * Whether this copy holds content the server's state vector does not cover, such as edits
   * loaded from the device. A delete adds no content, so only `unsent` catches those.
   */
  function hasContentBeyond(server: ReadonlyMap<number, number>): boolean {
    for (const [client, clock] of Y.decodeStateVector(Y.encodeStateVector(ydoc))) {
      if (clock > (server.get(client) ?? 0)) return true;
    }

    return false;
  }

  /**
   * Content the server sent since this sync began. The server makes its vector before it
   * answers, so another member's edit can reach this client first: it is the server's too.
   */
  let fromServer = new Map<number, number>();

  /** What the server has: its vector, and what it sent since. */
  function serverHas(serverVector: Uint8Array | undefined): Map<number, number> {
    const has = serverVector ? Y.decodeStateVector(serverVector) : new Map<number, number>();
    for (const [client, clock] of fromServer) {
      has.set(client, Math.max(clock, has.get(client) ?? 0));
    }

    return has;
  }

  function refuse(reason: string): void {
    for (const callback of [...refusals]) {
      try {
        callback({ reason });
      } catch (error) {
        onError(error);
      }
    }
  }

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

    fromServer = new Map();

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
    const server = serverHas(decodeBase64(info.vector) ?? undefined);
    const missing = Y.encodeStateAsUpdate(ydoc, Y.encodeStateVector(server));
    if (info.access === 'edit') {
      if (!isEmpty(missing)) send(missing);
    } else if (unsent || hasContentBeyond(server)) {
      // Local edits (made offline, before access changed) never reach a viewer's server.
      refuse('this client may only view the doc');
    }

    unsent = false;

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
      // The room ended while the socket stayed open: the server removed this client (a kick,
      // or `access` refused a rejoin). It does not join again by itself, so the doc closes.
      // `disconnect()` ends the room before the socket's state changes: look a turn later.
      if (state !== 'unsubscribed' && state !== 'failed') return;

      queueMicrotask(() => {
        const roomStatus = room.status.get();
        if (roomStatus !== 'unsubscribed' && roomStatus !== 'failed') return;

        if (!active || opening || options.connection.get() !== 'open') return;

        const error = new Error(`the server removed this client from ${ref.type}:${ref.id}`);
        // After the last close() the app has let the doc go: close it without an error.
        const wanted = opens > 0;
        stop(error);
        if (wanted) onError(error);
      });
    }),
    options.connection.subscribe((state) => {
      if (state !== 'open') {
        unsync();
        return;
      }

      // `reconnection()` joins the room again, but `disconnect()` then `connect()` ends it
      // for good: an open doc joins again itself. `open()` joins while it is opening.
      const roomStatus = room.status.get();
      if (active && !opening && (roomStatus === 'unsubscribed' || roomStatus === 'failed')) {
        // A refusal leaves the room 'failed', and the check above reports it once.
        room.subscribe().catch(() => {});
      }
    }),
    room.binary.on('update', (info, bytes) => {
      incoming.push(bytes.slice());
      if (info && info.part[0] < info.part[1] - 1) return;

      const update = joinBytes(incoming);
      incoming = [];
      try {
        Y.applyUpdate(ydoc, update, FROM_SERVER);
        // `to` is where each client's content in the update ends, from any start.
        for (const [client, clock] of Y.parseUpdateMeta(update).to) {
          fromServer.set(client, Math.max(clock, fromServer.get(client) ?? 0));
        }
      } catch (error) {
        onError(error);
      }
    }),
    room.binary.on('version', (info, bytes) => {
      versionParts.get(info.n)?.push(bytes.slice());
    }),
    room.binary.on('ack', (info) => {
      pending.delete(info.n);
      setStatus();
    }),
    room.binary.on('refused', (info, bytes) => {
      pending.delete(info.n);
      try {
        if (bytes.length > 0) Y.applyUpdate(ydoc, bytes, FROM_SERVER);
      } catch (error) {
        onError(error);
      }

      // An earlier update was lost on the way: nothing was undone, so sync again, which
      // sends everything the server lacks.
      if (info.reason === OUT_OF_ORDER) void sync();
      else refuse(info.reason);

      setStatus();
    }),
  ];

  /** Apply what the device holds, once. A failed load is tried again on the next open. */
  function loadFromDevice(): Promise<void> {
    loaded ??= (async () => {
      if (!storage) return;

      const reading = deviceWrites.then(() => storage.load(ref));
      deviceWrites = reading.then(
        () => {},
        () => {},
      );
      const updates = await reading;
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

  /**
   * Close the doc now: every `open()` still waiting gets `error`. Each failed `open()` stays
   * counted, so its caller's `close()` does not take away a later caller's `open()`.
   */
  function stop(error: unknown): void {
    if (lingering) clearTimeout(lingering);

    lingering = null;
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

  function checkCanEdit(): void {
    if (access.store.get() !== 'view') return;

    throw new LiveThingError<'read-only', ReadOnlyDetail>('read-only', {
      type: ref.type,
      id: ref.id,
    });
  }

  /** Wait until the server acked every change this client sent, or the doc went offline. */
  function sentAll(): Promise<void> {
    if (pending.size === 0) return Promise.resolve();

    return new Promise((resolve) => {
      const stopWatching = status.store.subscribe((value) => {
        if (value === 'saving') return;

        stopWatching();
        resolve();
      });
    });
  }

  /** A version as a Y.Doc. Its state comes as `version` parts before the answer. */
  async function readVersion(id: string): Promise<Y.Doc> {
    reads += 1;
    const n = reads;
    versionParts.set(n, []);
    try {
      await room.binary.request('read-version', new Uint8Array(0), { info: { id, n } });
      const version = new Y.Doc();
      Y.applyUpdate(version, joinBytes(versionParts.get(n)!));
      return version;
    } finally {
      versionParts.delete(n);
    }
  }

  const versions: DocVersions<D> = {
    async save(label) {
      await sentAll();
      return room.request('save-version', { label });
    },
    async list() {
      return (await room.request('list-versions', null)).versions;
    },
    async read(id) {
      const version = new DocCore(def, await readVersion(id));
      try {
        return version.read();
      } finally {
        version.destroy();
      }
    },
    async restore(id) {
      checkCanEdit();
      const version = await readVersion(id);
      checkVersion(def, version);
      handle.change(() => restoreFrom(ydoc, version, def));
    },
    async delete(id) {
      await room.request('delete-version', { id });
    },
  };

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
      checkCanEdit();
      return docState.change(mutate);
    },
    keyOf: docState.keyOf,
    // An undo or a redo is a change, so it needs edit access too.
    history: {
      ...docState.history,
      undo() {
        checkCanEdit();
        docState.history.undo();
      },
      redo() {
        checkCanEdit();
        docState.history.redo();
      },
    },
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
    versions,
  };

  return handle;
}
