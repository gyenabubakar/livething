import { createStore, derive } from '~/client/store.ts';
import { itemAnchor, resolveItem, resolveText, textAnchor } from '~/doc/anchors.ts';
import { ChangeOrigin, DocCore } from '~/doc/core.ts';
import * as Y from 'yjs';
import type { ReadableStore } from '~/client/store.ts';
import type {
  Anchor,
  ItemAnchor,
  ItemPlace,
  TextAnchor,
  TextPlace,
  TextRange,
} from '~/doc/anchors.ts';
import type { DocDef, Draft, ItemRef, PathOf, Snapshot, YRef } from '~/schema.ts';

/**
 * Undo and redo of this client's own changes.
 * @declarationEmit
 */
export interface DocHistory {
  /**
   * Undo this client's last `change()`. Only this client's own changes are undone: if
   * someone else edited meanwhile, their edits stay. The undo is a new change, so every
   * member gets it.
   */
  undo(): void;
  /** Do again the last change `undo()` took back. */
  redo(): void;
  readonly canUndo: ReadableStore<boolean>;
  readonly canRedo: ReadableStore<boolean>;
  /** Changes until `resume()` become one undo step, such as during a drag. */
  pause(): void;
  /** End a `pause()`. */
  resume(): void;
}

/**
 * A picker reads a path such as `(p) => p.tasks[0].notes`. With `noUncheckedIndexedAccess`
 * an index can read as `undefined`, so a picker may end with `?.` (`p.tasks[0]?.notes`); it
 * reads no data, so the path is the same.
 */
type Picker<D extends DocDef, T> = (path: PathOf<D['shape']>) => T | undefined;

/**
 * Anchors on a doc's words and items, and stores of where they are now.
 * @declarationEmit
 */
export interface DocAnchors<D extends DocDef> {
  /** An anchor on characters `from` to `to` (end not included) of a text or rich text field. */
  text(pick: Picker<D, YRef<Y.Text | Y.XmlFragment>>, range: TextRange): TextAnchor;
  /** An anchor on a list item or record entry. It stays on the item when the item moves. */
  item(pick: Picker<D, ItemRef>): ItemAnchor;
  /** Where an anchor is now, or `null` once its words or item are deleted. */
  watch(anchor: TextAnchor): ReadableStore<TextPlace | null>;
  watch(anchor: ItemAnchor): ReadableStore<ItemPlace | null>;
  /** A stored anchor of either kind, such as one read back from JSON. */
  watch(anchor: Anchor): ReadableStore<TextPlace | ItemPlace | null>;
}

/** The parts of a client doc that read and edit its content. */
export interface DocState<D extends DocDef> {
  /**
   * The doc's content as a read-only, plain JSON copy. Each change gives a new copy that
   * reuses every part that did not change, so `===` tells you what changed.
   */
  readonly state: ReadableStore<Snapshot<D['shape']>>;
  /**
   * A store of one part of `state`. It notifies only when `selector`'s result changes (by
   * `===`), so a component that shows one task does not re-render when another task changes.
   *
   * @example
   * ```ts
   * const task = board.select((s) => s.tasks.find((t) => t.id === 't_1042'))
   * ```
   */
  select<T>(selector: (state: Snapshot<D['shape']>) => T): ReadableStore<T>;
  /**
   * Edit the doc. `mutate` runs once, at once, with a draft shaped like the doc. Everything
   * it writes is one edit: one undo step, one update to the server, one store update.
   * Assigning text changes only the letters that differ, so others' edits to the same text
   * stay. If `mutate` throws, or a value fails its schema, nothing changes. Works offline:
   * the edit goes out on the next join. Returns what `mutate` returns.
   *
   * @throws `invalid-change` when a value fails its schema, and `read-only` in a doc this
   * client may only view.
   *
   * @example
   * ```ts
   * board.change((d) => {
   *   d.title = 'Launch plan'
   *   const task = d.tasks.find((t) => t.id === 't_1042')
   *   if (task) task.done = true
   * })
   * ```
   */
  change<R>(mutate: (draft: Draft<D['shape']>) => R): R;
  /**
   * A list item's internal ID, from an item object of `state`, or `undefined` for an object
   * that is not a list item. It stays the same when the item moves: a good key for rendering
   * lists.
   */
  keyOf(item: object): string | undefined;
  /** Undo and redo of this client's own changes. */
  readonly history: DocHistory;
  /** Anchors that stay on their words or items as people edit, and stores of where they are. */
  readonly anchor: DocAnchors<D>;
  /** The raw Yjs objects, for rich text editors. */
  readonly yjs: {
    /** The doc's `Y.Doc`. Writes made straight to it are not checked until the server sees them. */
    readonly doc: Y.Doc;
    /**
     * The Yjs type behind a `text()` (`Y.Text`) or `richText()` (`Y.XmlFragment`) field, for
     * an editor binding. A path to any other field is a type error.
     *
     * @throws When the path leads to nothing, such as a list item that does not exist.
     */
    at<T>(pick: Picker<D, YRef<T>>): T;
  };
}

function samePlace(a: unknown, b: unknown): boolean {
  if (a === b) return true;

  if (!a || !b) return false;

  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;

  return Object.keys(left).every((key) => left[key] === right[key]);
}

/**
 * The reactive side of a doc on the client. Content that does not match the schema (from
 * an older or newer app version) keeps `state` at its last good copy, and `onError` gets
 * the error.
 */
export function createDocState<D extends DocDef>(
  core: DocCore<D>,
  onError: (error: unknown) => void,
): DocState<D> {
  let initial: Snapshot<D['shape']>;
  try {
    initial = core.read();
  } catch (error) {
    onError(error);
    initial = new DocCore(core.def).read();
  }

  const state = createStore(initial, onError);
  const watchers = new Set<() => void>();
  function refresh() {
    try {
      state.set(core.read());
    } catch (error) {
      onError(error);
    }

    for (const watcher of [...watchers]) watcher();
  }

  // A doc's state lives as long as its handle, which lives as long as the socket.
  core.subscribe(refresh);

  // The history tracks a change only once its function has run to the end (see `change`),
  // so a change that throws, and is rolled back, never reaches it: no step is left, a paused
  // step stays whole, and the redo stack stays.
  const undo = new Y.UndoManager([...core.roots.keys()], {
    trackedOrigins: new Set(),
    captureTimeout: 0,
  });
  const canUndo = createStore(false, onError);
  const canRedo = createStore(false, onError);
  function syncStacks() {
    canUndo.set(undo.canUndo());
    canRedo.set(undo.canRedo());
  }

  /** An undo inside a change() would become part of that change. */
  function checkOutsideChange(name: 'undo' | 'redo') {
    if (core.isOpen()) throw new Error(`history.${name}() cannot run inside a change()`);
  }

  undo.on('stack-item-added', syncStacks);
  undo.on('stack-item-popped', syncStacks);
  undo.on('stack-cleared', syncStacks);

  function watch(anchor: TextAnchor | ItemAnchor): ReadableStore<TextPlace | ItemPlace | null> {
    function place() {
      return anchor.kind === 'text'
        ? resolveText(core.ydoc, anchor)
        : resolveItem(core.ydoc, anchor);
    }

    const store = createStore(place(), onError);
    let current = store.store.get();
    let listeners = 0;
    function update() {
      const next = place();
      if (samePlace(current, next)) return;

      current = next;
      store.set(next);
    }

    return {
      get() {
        if (listeners === 0) update();
        return store.store.get();
      },
      subscribe(listener) {
        if (listeners === 0) {
          update();
          watchers.add(update);
        }

        listeners += 1;
        const unsubscribe = store.store.subscribe(listener);
        let subscribed = true;

        return () => {
          if (!subscribed) return;

          subscribed = false;
          unsubscribe();
          listeners -= 1;
          if (listeners === 0) watchers.delete(update);
        };
      },
    };
  }

  return {
    state: state.store,
    select: (selector) => derive(state.store, selector),
    change(mutate) {
      const origin = new ChangeOrigin();
      try {
        return core.change((draft) => {
          const result = mutate(draft);
          // The transaction ends after this returns, and then the history looks at it.
          if (!(result instanceof Promise)) undo.trackedOrigins.add(origin);
          return result;
        }, origin);
      } finally {
        undo.trackedOrigins.delete(origin);
      }
    },
    keyOf: (item) => core.keyOf(item),
    history: {
      undo() {
        checkOutsideChange('undo');
        undo.undo();
      },
      redo() {
        checkOutsideChange('redo');
        undo.redo();
      },
      canUndo: canUndo.store,
      canRedo: canRedo.store,
      pause() {
        undo.stopCapturing();
        undo.captureTimeout = Number.POSITIVE_INFINITY;
      },
      resume() {
        undo.captureTimeout = 0;
        undo.stopCapturing();
      },
    },
    anchor: {
      text: (pick, range) => textAnchor(core.resolve(pick), range),
      item: (pick) => itemAnchor(core.resolve(pick)),
      watch: watch as DocAnchors<D>['watch'],
    },
    yjs: {
      doc: core.ydoc,
      at(pick) {
        const type = core.resolve(pick).type;
        if (!type) throw new TypeError('yjs.at() needs a path to a text() or richText() field');

        return type as never;
      },
    },
  };
}
