/** One doc: its type and its ID. */
export interface DocRef<TType extends string = string> {
  readonly type: TType;
  readonly id: string;
}

/**
 * Where a doc's updates are kept: on the device (the client's `storage` option, such as
 * `indexedDbStorage()`), and on the server as part of `ServerStorage`. The bytes are Yjs
 * updates: keep them as they are. The plugin calls these one at a time for each doc, in
 * order. Each may return a promise. Most often a load comes first, but not always: on the
 * device, an edit made before the doc's first `open()` is appended before the load, so
 * `append` must work on a doc that was never loaded.
 *
 * @example
 * ```ts
 * // Docs on a React Native device, in a key-value store with an `append` and a `replace`.
 * const deviceStorage: CollaborationStorage = {
 *   load: (doc) => deviceStore.readAll(`${doc.type}:${doc.id}`),
 *   append: (doc, update) => deviceStore.append(`${doc.type}:${doc.id}`, update),
 *   compact: (doc, state) => deviceStore.replace(`${doc.type}:${doc.id}`, [state]),
 * }
 * ```
 */
export interface CollaborationStorage {
  /** Every stored update of a doc, oldest first. A doc never stored gives an empty list. */
  load(doc: DocRef): readonly Uint8Array[] | Promise<readonly Uint8Array[]>;
  /** Keep one more update of a doc. */
  append(doc: DocRef, update: Uint8Array): void | Promise<void>;
  /** Replace every stored update of a doc with `state`, one update that holds them all. */
  compact(doc: DocRef, state: Uint8Array): void | Promise<void>;
}
