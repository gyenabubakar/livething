/** One doc: its type and its ID. */
export interface DocRef<TType extends string = string> {
  readonly type: TType;
  readonly id: string;
}

/**
 * Where docs are kept: on the server (`sqlStorage` by default), or on the device (the
 * client's `storage` option). The plugin calls these one at a time for each doc, in order:
 * a load, then appends and compactions. Each may return a promise.
 */
export interface CollaborationStorage {
  /** Every stored update of a doc, oldest first. A doc never stored gives an empty list. */
  load(doc: DocRef): readonly Uint8Array[] | Promise<readonly Uint8Array[]>;
  /** Keep one more update of a doc. */
  append(doc: DocRef, update: Uint8Array): void | Promise<void>;
  /** Replace every stored update of a doc with `state`, one update that holds them all. */
  compact(doc: DocRef, state: Uint8Array): void | Promise<void>;
}
