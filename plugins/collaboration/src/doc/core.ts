import { fixedDraft } from '~/doc/draft.ts';
import { rootTypes } from '~/doc/layout.ts';
import { recordPath, resolvePath } from '~/doc/paths.ts';
import { Snapshots } from '~/doc/snapshot.ts';
import { isThenable } from '~/doc/thenable.ts';
import { setText } from '~/doc/values.ts';
import * as Y from 'yjs';
import type { DraftContext } from '~/doc/draft.ts';
import type { RootSlot } from '~/doc/layout.ts';
import type { PathEnd } from '~/doc/paths.ts';
import type { DocDef, Draft, PathOf, Snapshot } from '~/schema.ts';

/**
 * The origin of one `change()`. Each change gets its own, so the change can be rolled back
 * alone, and an undo history can track every change by this class.
 */
export class ChangeOrigin {}

/**
 * One doc, on the server or the client: its Yjs doc, its snapshot, and `change()`. It knows
 * nothing about stores, the network or undo; the server plugin and the client handle build
 * on it.
 */
export class DocCore<D extends DocDef = DocDef> {
  readonly def: D;
  readonly ydoc: Y.Doc;
  /** Every root type of the doc, with what it holds. */
  readonly roots: ReadonlyMap<Y.AbstractType<any>, RootSlot>;
  /** The snapshot cache. Drafts read through it. */
  readonly snapshots: Snapshots;
  /** A root list's `items` map stands for the list in the cache under its `order` array. */
  private readonly listOfItems = new Map<Y.AbstractType<any>, Y.AbstractType<any>>();
  private readonly listeners = new Set<() => void>();
  private readonly onTransaction: (transaction: Y.Transaction) => void;
  private ids = 0;
  private changes = 0;
  private changing = false;

  constructor(def: D, ydoc: Y.Doc = new Y.Doc()) {
    this.def = def;
    this.ydoc = ydoc;
    this.snapshots = new Snapshots(ydoc);
    this.roots = rootTypes(ydoc, def.shape);

    const orderOf = new Map<string, Y.AbstractType<any>>();
    for (const [type, slot] of this.roots) {
      if (slot.kind === 'order') orderOf.set(nameOf(ydoc, type), type);
    }

    for (const [type, slot] of this.roots) {
      if (slot.kind === 'items') {
        this.listOfItems.set(type, orderOf.get(nameOf(ydoc, type).slice(0, -'#items'.length))!);
      }
    }

    this.onTransaction = (transaction) => {
      for (const type of [
        ...transaction.changedParentTypes.keys(),
        ...transaction.changed.keys(),
      ]) {
        this.snapshots.dirty.add(type);
        const list = this.listOfItems.get(type);
        if (list) this.snapshots.dirty.add(list);
      }

      if (!this.changing) this.notify();
    };
    ydoc.on('afterTransaction', this.onTransaction);
  }

  /** The doc as a read-only, plain JSON copy. Throws when stored content does not match the schema. */
  read(): Snapshot<D['shape']> {
    return this.snapshots.doc(this.def.shape) as Snapshot<D['shape']>;
  }

  /**
   * Edit the doc. `mutate` gets a draft and runs at once; everything it writes is one Yjs
   * transaction with `origin`. If it throws, or writes a value the schema refuses, its
   * writes are undone, and listeners are notified once, with the doc as it was (the same
   * snapshot object). Returns what `mutate` returns.
   */
  change<R>(mutate: (draft: Draft<D['shape']>) => R, origin: ChangeOrigin = new ChangeOrigin()): R {
    if (this.changing) throw new Error('change() cannot be called inside another change()');

    const rollback = new Y.UndoManager([...this.roots.keys()], {
      trackedOrigins: new Set([origin]),
      captureTimeout: 0,
    });
    // Each change's draft can write only during that change, not after it or in a later one.
    this.changes += 1;
    const id = this.changes;
    const draftContext: DraftContext = {
      ydoc: this.ydoc,
      snapshots: this.snapshots,
      newId: () => this.newId(),
      isOpen: () => this.changing && this.changes === id,
      texts: new Map(),
    };

    // `find` and `findIndex` read snapshots, which stay as they were until the change ends.
    // Build them first, so every item reads as it was when the change began.
    try {
      this.read();
    } catch {
      // Content the schema refuses throws where the draft reads it.
    }

    this.changing = true;
    let result!: R;

    let failure: { error: unknown } | null = null;
    try {
      this.ydoc.transact(() => {
        result = mutate(fixedDraft(draftContext, this.def.shape) as Draft<D['shape']>);
        if (isThenable(result)) {
          Promise.resolve(result).catch(() => {});
          throw new Error('change() runs at once: pass a function that is not async');
        }

        for (const [ytext, next] of draftContext.texts) setText(ytext, next);
      }, origin);
    } catch (error) {
      failure = { error };
      // A Yjs transaction cannot be cancelled, so undo what ran before the throw.
      rollback.undo();
    } finally {
      rollback.destroy();
      this.changing = false;
    }

    // One notification for the whole change. After a rollback the content is as before,
    // so a listener that reads the snapshot gets the same object.
    this.notify();

    if (failure) throw failure.error;

    return result;
  }

  /** Run `listener` after each transaction that changed the doc, and once after each `change()`. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }

  /** Whether a `change()` is running, so a draft may write. */
  isOpen(): boolean {
    return this.changing;
  }

  /** A new list item ID, unique in this doc: this copy's Yjs client ID and a counter. */
  newId(): string {
    this.ids += 1;
    return `${this.ydoc.clientID.toString(36)}.${this.ids.toString(36)}`;
  }

  /** Where a picker such as `(p) => p.tasks[0].title` leads in the doc as it is now. */
  resolve(pick: (path: PathOf<D['shape']>) => unknown): PathEnd {
    return resolvePath(this.ydoc, this.def.shape, recordPath(pick));
  }

  /** The list ID of an item object from a snapshot. It stays the same when the item moves. */
  keyOf(item: object): string | undefined {
    return this.snapshots.keys.get(item);
  }

  destroy(): void {
    this.ydoc.off('afterTransaction', this.onTransaction);
    this.listeners.clear();
  }
}

function nameOf(ydoc: Y.Doc, type: Y.AbstractType<any>): string {
  for (const [name, root] of ydoc.share) if (root === type) return name;

  throw new Error('not a root type of this doc');
}
