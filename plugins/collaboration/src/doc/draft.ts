import { liveIds, nestedList, rootList, rootType, valuesMap } from '~/doc/layout.ts';
import { checkString, invalidChange, richTextFrom, writeValue } from '~/doc/values.ts';
import { kindOf } from '~/schema.ts';
import * as Y from 'yjs';
import type { ListParts } from '~/doc/layout.ts';
import type { Snapshots } from '~/doc/snapshot.ts';
import type { Field, Leaf, ListField, RecordField, Shape } from '~/schema.ts';

/** What a draft needs from the doc it edits. */
export interface DraftContext {
  readonly ydoc: Y.Doc;
  readonly snapshots: Snapshots;
  /** A new list item ID, unique in this doc. */
  newId(): string;
  /** Whether this draft's `change()` is running. A draft kept past its change can't write. */
  isOpen(): boolean;
  /**
   * Text assigned in this change, written when the change function returns. A change that
   * throws then never deletes characters, so its rollback brings none back: the undo
   * history cannot find characters that an undo brought back (a Yjs limit), and a later undo
   * would miss them.
   */
  readonly texts: Map<Y.Text, string>;
}

/** Refuse a write through a draft whose `change()` has ended. */
function checkOpen(at: DraftAt): void {
  if (!at.ctx.isOpen()) {
    throw invalidChange(
      at.path,
      'a draft can only be changed inside its change(), so the edit is one undoable step',
    );
  }
}

/** The doc a draft edits, and the schema path of the part at hand, such as `tasks[].done`. */
interface DraftAt {
  readonly ctx: DraftContext;
  readonly path: string;
}

function under(at: DraftAt, step: string): DraftAt {
  return { ctx: at.ctx, path: at.path === '' ? step : `${at.path}${step}` };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  );
}

/** Turn a written value into Yjs content, checking it against its field. */
function toY(at: DraftAt, field: Field, input: unknown): unknown {
  const { ctx, path } = at;
  switch (kindOf(field)) {
    case 'leaf':
      return writeValue(field as Leaf, input, path);

    case 'text':
      return new Y.Text(checkString(path, input, 'text'));

    case 'rich-text':
      return richTextFrom(checkString(path, input, 'rich text'));

    case 'list': {
      if (!Array.isArray(input)) throw invalidChange(path, 'a list must be an array');

      const item = under(at, '[]');
      const items = new Y.Map<unknown>();
      const ids = input.map((value) => {
        const id = ctx.newId();
        items.set(id, toY(item, (field as ListField).item, value));
        return id;
      });
      const order = new Y.Array<string>();
      order.insert(0, ids);

      const map = new Y.Map<unknown>();
      map.set('order', order);
      map.set('items', items);
      return map;
    }

    case 'record': {
      if (!isPlainObject(input)) throw invalidChange(path, 'a record must be a plain object');

      const map = new Y.Map<unknown>();
      for (const [key, value] of Object.entries(input)) {
        const checked = checkString(path, key, 'a record key');
        map.set(checked, toY(under(at, '{}'), (field as RecordField).item, value));
      }

      return map;
    }

    case 'shape': {
      if (!isPlainObject(input)) throw invalidChange(path, 'expected a plain object');

      const map = new Y.Map<unknown>();
      for (const [key, sub] of Object.entries(field as Shape)) {
        map.set(key, toY(under(at, `.${key}`), sub, input[key]));
      }

      return map;
    }
  }
}

/** A Yjs type to write to. A draft of an item the same change deleted would lose the write. */
function live<T extends Y.AbstractType<any>>(at: DraftAt, type: T): T {
  if (type._item?.deleted) throw invalidChange(at.path, 'the item was deleted');

  return type;
}

/** A nested list, record or object that is not there. */
const MISSING =
  'it is missing: its item was deleted in this change, or was stored before this field existed';

/** A draft of a field inside a list item or record value. */
function draftOf(at: DraftAt, field: Field, raw: unknown): unknown {
  const { ctx, path } = at;
  switch (kindOf(field)) {
    case 'leaf':
      return ctx.snapshots.value(field as Leaf, raw, path);

    case 'text':
      return ctx.texts.get(raw as Y.Text) ?? ctx.snapshots.field(field, raw, path);

    case 'rich-text':
      return ctx.snapshots.field(field, raw, path);

    case 'list': {
      const parts = nestedList(raw);
      if (!parts) throw invalidChange(path, MISSING);

      return listDraft(at, (field as ListField).item, parts);
    }

    case 'record':
      if (!(raw instanceof Y.Map)) throw invalidChange(path, MISSING);

      return recordDraft(at, (field as RecordField).item, raw);

    case 'shape': {
      if (!(raw instanceof Y.Map)) throw invalidChange(path, MISSING);

      const map = raw;
      return shapeDraft(at, field as Shape, {
        read: (key) => map.get(key),
        write: (key, value) => live(at, map).set(key, value),
        text: (key) => live(at, map).get(key) as Y.Text,
      });
    }
  }
}

/** The index in `order` where an item that should land at list index `index` goes. */
function orderPosition(parts: ListParts, ids: readonly string[], index: number): number {
  if (index >= ids.length) return parts.order.length;

  return parts.order.toArray().indexOf(ids[Math.max(0, index)]!);
}

function removeEverywhere(order: Y.Array<string>, id: string): void {
  const ids = order.toArray();
  for (let index = ids.length - 1; index >= 0; index -= 1) {
    if (ids[index] === id) order.delete(index, 1);
  }
}

function checkIndex(path: string, index: unknown): number {
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
    throw invalidChange(
      path,
      `the index must be a whole number of 0 or more, got ${String(index)}`,
    );
  }

  return index;
}

function listDraft(at: DraftAt, item: Field, parts: ListParts) {
  const { ctx, path } = at;
  const itemAt = under(at, '[]');

  function draftAt(id: string | undefined) {
    return id === undefined ? undefined : draftOf(itemAt, item, parts.items.get(id));
  }

  function snapshotOf(id: string) {
    return ctx.snapshots.field(item, parts.items.get(id), itemAt.path);
  }

  /** Before a write: inside its change, and its item not deleted by the same change. */
  function writable() {
    checkOpen(at);
    live(at, parts.key);
  }

  function insert(index: number, inputs: readonly unknown[]) {
    writable();
    const ids = liveIds(parts);
    const fresh = inputs.map((input) => {
      const id = ctx.newId();
      parts.items.set(id, toY(itemAt, item, input));
      return id;
    });
    parts.order.insert(orderPosition(parts, ids, index), fresh);
  }

  return {
    get length() {
      return liveIds(parts).length;
    },
    at: (index: number) => draftAt(liveIds(parts)[checkIndex(path, index)]),
    find: (predicate: (value: unknown) => boolean) =>
      draftAt(liveIds(parts).find((id) => predicate(snapshotOf(id)))),
    findIndex: (predicate: (value: unknown) => boolean) =>
      liveIds(parts).findIndex((id) => predicate(snapshotOf(id))),
    push: (...inputs: unknown[]) => insert(Infinity, inputs),
    insert: (index: number, ...inputs: unknown[]) => insert(checkIndex(path, index), inputs),
    set(index: number, input: unknown) {
      writable();
      const id = liveIds(parts)[checkIndex(path, index)];
      if (id === undefined) throw invalidChange(path, `there is no item at index ${index}`);

      parts.items.set(id, toY(itemAt, item, input));
    },
    delete(index: number, count = 1) {
      writable();
      const from = checkIndex(path, index);
      for (const id of liveIds(parts).slice(from, from + checkIndex(path, count))) {
        parts.items.delete(id);
        removeEverywhere(parts.order, id);
      }
    },
    move(from: number, to: number) {
      writable();
      const id = liveIds(parts)[checkIndex(path, from)];
      if (id === undefined) throw invalidChange(path, `there is no item at index ${from}`);

      checkIndex(path, to);
      removeEverywhere(parts.order, id);
      parts.order.insert(orderPosition(parts, liveIds(parts), to), [id]);
    },
    *[Symbol.iterator]() {
      for (const id of liveIds(parts)) yield draftAt(id);
    },
  };
}

function recordDraft(at: DraftAt, item: Field, map: Y.Map<unknown>) {
  const itemAt = under(at, '{}');
  return {
    get size() {
      return map.size;
    },
    get: (key: string) => (map.has(key) ? draftOf(itemAt, item, map.get(key)) : undefined),
    has: (key: string) => map.has(key),
    set(key: string, input: unknown) {
      checkOpen(at);
      live(at, map).set(checkString(at.path, key, 'a record key'), toY(itemAt, item, input));
    },
    delete(key: string) {
      checkOpen(at);
      live(at, map).delete(key);
    },
    keys: () => map.keys(),
  };
}

/** How a draft object reads and writes its fields. */
interface ShapeAccess {
  read(key: string): unknown;
  write(key: string, value: unknown): void;
  text(key: string): Y.Text;
}

/** Why a field of each kind can't be assigned, as a refusal says it. */
const NOT_ASSIGNED: Record<'rich-text' | 'list' | 'record' | 'shape', string> = {
  'rich-text': 'rich text is changed through an editor, not by assigning',
  list: 'a list is changed through its methods, not by assigning',
  record: 'a record is changed through its methods, not by assigning',
  shape: 'an object is changed field by field, not by assigning',
};

function shapeDraft(at: DraftAt, shape: Shape, access: ShapeAccess): object {
  const target = {};
  for (const [key, field] of Object.entries(shape)) {
    const kind = kindOf(field);
    const fieldAt = under(at, at.path === '' ? key : `.${key}`);
    Object.defineProperty(target, key, {
      enumerable: true,
      get: () => draftOf(fieldAt, field, access.read(key)),
      set(value: unknown) {
        checkOpen(fieldAt);
        if (kind === 'text') {
          at.ctx.texts.set(access.text(key), checkString(fieldAt.path, value, 'text'));
        } else if (kind === 'leaf') {
          access.write(key, writeValue(field as Leaf, value, fieldAt.path));
        } else {
          throw invalidChange(fieldAt.path, NOT_ASSIGNED[kind]);
        }
      },
    });
  }

  return Object.seal(target);
}

/** The draft of a fixed object: its values in its values map, the rest in root types. */
export function fixedDraft(ctx: DraftContext, shape: Shape, path: readonly string[] = []): object {
  const values = valuesMap(ctx.ydoc, path);
  const target = {};
  for (const [key, field] of Object.entries(shape)) {
    const fieldPath = [...path, key];
    const where = fieldPath.join('.');
    const kind = kindOf(field);
    if (kind === 'shape' || kind === 'list') {
      Object.defineProperty(target, key, {
        enumerable: true,
        get: () =>
          kind === 'shape'
            ? fixedDraft(ctx, field as Shape, fieldPath)
            : listDraft(
                { ctx, path: where },
                (field as ListField).item,
                rootList(ctx.ydoc, fieldPath),
              ),
        set: () => {
          throw invalidChange(
            where,
            kind === 'shape'
              ? 'an object is changed field by field, not by assigning'
              : 'a list is changed through its methods, not by assigning',
          );
        },
      });
      continue;
    }

    const single = shapeDraft(
      { ctx, path: path.join('.') },
      { [key]: field },
      {
        read: (name) => (kind === 'leaf' ? values.get(name) : rootType(ctx.ydoc, field, fieldPath)),
        write: (name, value) => values.set(name, value),
        text: () => rootType(ctx.ydoc, field, fieldPath) as Y.Text,
      },
    );
    Object.defineProperty(target, key, Object.getOwnPropertyDescriptor(single, key)!);
  }

  return Object.seal(target);
}
