import { liveIds, nestedList, rootList, rootType } from '~/doc/layout.ts';
import { kindOf } from '~/schema.ts';
import * as Y from 'yjs';
import type { ListParts } from '~/doc/layout.ts';
import type { Field, ListField, RecordField, Shape } from '~/schema.ts';

/** Run a picker such as `(p) => p.tasks[0].notes` and give the keys it read, in order. */
export function recordPath(pick: (path: any) => unknown): string[] {
  const keys: string[] = [];
  const recorder: object = new Proxy(
    {},
    {
      get(_, key) {
        if (typeof key !== 'string') {
          throw new TypeError('a path picker reads only field names and indexes');
        }

        keys.push(key);
        return recorder;
      },
    },
  );
  pick(recorder);
  return keys;
}

/** Where a path ends: a Yjs type (text or rich text), or one list item or record entry. */
export type PathEnd =
  | { readonly kind: 'type'; readonly type: Y.AbstractType<any> }
  | {
      readonly kind: 'list-item';
      readonly parts: ListParts;
      readonly id: string;
      /** The item's text, when the item itself is text or rich text. */
      readonly type?: Y.AbstractType<any>;
    }
  | {
      readonly kind: 'record-entry';
      readonly map: Y.Map<unknown>;
      readonly key: string;
      readonly type?: Y.AbstractType<any>;
    };

/** Where the walk is: in a fixed object, a stored object or record, a list, a type, or a value. */
type Cursor =
  | { readonly at: 'fixed'; readonly path: readonly string[] }
  | { readonly at: 'map'; readonly map: Y.Map<unknown> }
  | { readonly at: 'list'; readonly parts: ListParts }
  | { readonly at: 'type'; readonly type: Y.AbstractType<any> }
  | { readonly at: 'value' };

/** The path does not reach anything in the doc as it is now. */
class PathError extends Error {}

/** The cursor for stored content `raw` of a field. `null` when the content doesn't fit. */
function cursorOf(field: Field, raw: unknown): Cursor | null {
  switch (kindOf(field)) {
    case 'leaf':
      return { at: 'value' };

    case 'list': {
      const parts = nestedList(raw);
      return parts ? { at: 'list', parts } : null;
    }

    case 'shape':
    case 'record':
      return raw instanceof Y.Map ? { at: 'map', map: raw as Y.Map<unknown> } : null;

    default:
      return raw instanceof Y.AbstractType ? { at: 'type', type: raw } : null;
  }
}

/** The cursor for a field of a fixed object, at `path`. */
function fixedCursor(ydoc: Y.Doc, field: Field, path: readonly string[]): Cursor | null {
  switch (kindOf(field)) {
    case 'shape':
      return { at: 'fixed', path };

    case 'list':
      return { at: 'list', parts: rootList(ydoc, path) };

    case 'leaf':
      return { at: 'value' };

    default:
      return cursorOf(field, rootType(ydoc, field, path));
  }
}

/** Follow `keys` from the top of a doc. Throws a {@link PathError} when it doesn't reach one. */
export function resolvePath(ydoc: Y.Doc, shape: Shape, keys: readonly string[]): PathEnd {
  function fail(why: string): never {
    throw new PathError(`the path '${keys.join('.')}' ${why}`);
  }

  let field: Field = shape;
  let cursor: Cursor | null = { at: 'fixed', path: [] };
  let item: PathEnd | null = null;

  for (const key of keys) {
    const kind = kindOf(field);
    item = null;

    if (kind === 'shape' && cursor?.at === 'fixed') {
      const next: Field | undefined = (field as Shape)[key];
      if (next === undefined) fail(`has no field '${key}'`);

      field = next!;
      cursor = fixedCursor(ydoc, field, [...cursor.path, key]);
    } else if (kind === 'shape' && cursor?.at === 'map') {
      const next: Field | undefined = (field as Shape)[key];
      if (next === undefined) fail(`has no field '${key}'`);

      field = next!;
      cursor = cursorOf(field, cursor.map.get(key));
    } else if (kind === 'list' && cursor?.at === 'list') {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0) fail(`reads '${key}' from a list, not an index`);

      const id = liveIds(cursor.parts)[index];
      if (id === undefined) fail(`has no item at index ${index}`);

      item = { kind: 'list-item', parts: cursor.parts, id: id! };
      field = (field as ListField).item;
      cursor = cursorOf(field, cursor.parts.items.get(id!));
    } else if (kind === 'record' && cursor?.at === 'map') {
      if (!cursor.map.has(key)) fail(`has no entry '${key}'`);

      item = { kind: 'record-entry', map: cursor.map, key };
      field = (field as RecordField).item;
      cursor = cursorOf(field, cursor.map.get(key));
    } else {
      fail(`cannot read '${key}' here`);
    }

    if (cursor === null) fail(`reaches '${key}', which does not hold what the schema says`);
  }

  if (item) return cursor?.at === 'type' ? { ...item, type: cursor.type } : item;

  if (cursor?.at === 'type') return { kind: 'type', type: cursor.type };

  return fail(
    cursor?.at === 'value'
      ? 'ends at a plain value, which has no Yjs type'
      : 'ends at no item and no text',
  );
}
