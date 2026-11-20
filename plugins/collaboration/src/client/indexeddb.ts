import * as Y from 'yjs';
import type { CollaborationStorage, DocRef } from '~/doc/storage.ts';

const STORE = 'updates';
const BY_DOC = 'doc';

export interface IndexedDbStorageOptions {
  /** The IndexedDB database name. Default `'livething-collaboration'`. */
  readonly name?: string;
  /** The IndexedDB to use. Default: the browser's `indexedDB`. */
  readonly indexedDB?: IDBFactory;
}

interface UpdateRecord {
  readonly doc: string;
  readonly update: Uint8Array;
}

function keyOf(doc: DocRef): string {
  return `${doc.type}:${doc.id}`;
}

function done(request: IDBRequest | IDBTransaction): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if ('oncomplete' in request) {
      request.oncomplete = () => resolve(undefined);
      request.onabort = () => reject(request.error);
    } else {
      request.onsuccess = () => resolve(request.result);
    }

    request.onerror = () => reject(request.error);
  });
}

/**
 * Keeps docs on the device in IndexedDB, for the client's `storage` option: an edit made
 * offline survives a reload, and syncs once the app is online again.
 *
 * @example
 * ```ts
 * export const HuddleCollaboration = collaboration({
 *   docs: huddleDocs,
 *   storage: indexedDbStorage(),
 * })
 * ```
 */
export function indexedDbStorage(options: IndexedDbStorageOptions = {}): CollaborationStorage {
  let opening: Promise<IDBDatabase> | null = null;

  function database(): Promise<IDBDatabase> {
    opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      const factory = options.indexedDB ?? globalThis.indexedDB;
      if (!factory) {
        reject(new Error('indexedDbStorage() needs IndexedDB, which this runtime does not have'));
        return;
      }

      const request = factory.open(options.name ?? 'livething-collaboration', 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore(STORE, { autoIncrement: true });
        store.createIndex(BY_DOC, BY_DOC);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    // A failed open is not kept, so the next call tries again.
    opening.catch(() => {
      opening = null;
    });

    return opening;
  }

  return {
    async load(doc) {
      const db = await database();
      const index = db.transaction(STORE, 'readonly').objectStore(STORE).index(BY_DOC);
      // An index lists equal keys in primary key order: the order they were added.
      const records = (await done(index.getAll(keyOf(doc)))) as UpdateRecord[];

      return records.map((record) => record.update);
    },
    async append(doc, update) {
      const db = await database();
      const transaction = db.transaction(STORE, 'readwrite');
      transaction.objectStore(STORE).add({ doc: keyOf(doc), update: update.slice() });
      await done(transaction);
    },
    async compact(doc, state) {
      const db = await database();
      const transaction = db.transaction(STORE, 'readwrite');
      const store = transaction.objectStore(STORE);
      const index = store.index(BY_DOC);

      const keys = (await done(index.getAllKeys(keyOf(doc)))) as IDBValidKey[];
      const records = (await done(index.getAll(keyOf(doc)))) as UpdateRecord[];
      for (const key of keys) store.delete(key);

      // Another tab of the app may have stored updates this tab has not seen: keep them too.
      const merged = Y.mergeUpdates([...records.map((record) => record.update), state]);
      store.add({ doc: keyOf(doc), update: merged });
      await done(transaction);
    },
  };
}
