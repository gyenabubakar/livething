import { kindOf } from '~/schema.ts';
import * as Y from 'yjs';
import type { Field, ListField, Shape } from '~/schema.ts';

// Where each part of a doc lives in Yjs.
//
// The fixed parts of the schema are root types, found by name, so two clients that start a
// doc offline never race to create them. A path of field names joins with `/`: `tasks`,
// `meta/notes`. Field names can't hold `/`, `#` or `~`, so no two parts share a name.
//
// - the plain values of a fixed object: a `Y.Map` named `~` (top) or `meta/~`;
// - text and rich text: a `Y.Text` or `Y.XmlFragment` named by its path;
// - a record: a `Y.Map` named by its path;
// - a list: two parts, `order` (a `Y.Array` of item IDs, named by its path) and `items` (a
//   `Y.Map` from ID to item, named `<path>#items`). A move changes only `order`, so the item
//   itself is never copied.
//
// Inside a list item or record value, everything is nested: an object is a `Y.Map` of its
// fields, and a list is a `Y.Map` holding `order` and `items`.

const VALUES = '~';
const ITEMS = '#items';

function rootName(path: readonly string[]): string {
  return path.join('/');
}

function valuesName(path: readonly string[]): string {
  return path.length === 0 ? VALUES : `${rootName(path)}/${VALUES}`;
}

export function valuesMap(ydoc: Y.Doc, path: readonly string[]): Y.Map<unknown> {
  return ydoc.getMap(valuesName(path));
}

/** A list's two parts. `key` stands for the whole list in the snapshot cache. */
export interface ListParts {
  readonly order: Y.Array<string>;
  readonly items: Y.Map<unknown>;
  readonly key: Y.AbstractType<any>;
}

export function rootList(ydoc: Y.Doc, path: readonly string[]): ListParts {
  const order = ydoc.getArray<string>(rootName(path));
  return { order, items: ydoc.getMap(`${rootName(path)}${ITEMS}`), key: order };
}

/** A list inside a list item or record value, or `null` when `map` doesn't hold one. */
export function nestedList(map: unknown): ListParts | null {
  if (!(map instanceof Y.Map)) return null;

  const order: unknown = map.get('order');
  const items: unknown = map.get('items');
  if (!(order instanceof Y.Array) || !(items instanceof Y.Map)) return null;

  return { order: order as Y.Array<string>, items: items as Y.Map<unknown>, key: map };
}

/** The root type of a fixed text, rich text or record field. */
export function rootType(ydoc: Y.Doc, field: Field, path: readonly string[]): Y.AbstractType<any> {
  const name = rootName(path);
  switch (kindOf(field)) {
    case 'text':
      return ydoc.getText(name);

    case 'rich-text':
      return ydoc.getXmlFragment(name);

    case 'record':
      return ydoc.getMap(name);

    default:
      throw new Error(`'${name}' has no root type of its own`);
  }
}

/** What a root type holds. */
export type RootSlot =
  | { readonly kind: 'values'; readonly shape: Shape }
  | { readonly kind: 'order' }
  | { readonly kind: 'items'; readonly list: ListField }
  | { readonly kind: 'field'; readonly field: Field };

/** Every root type of a doc, by name, with what it holds. */
function rootSlots(shape: Shape, path: string[] = [], out = new Map<string, RootSlot>()) {
  out.set(valuesName(path), { kind: 'values', shape });
  for (const [key, field] of Object.entries(shape)) {
    const at = [...path, key];
    const kind = kindOf(field);
    if (kind === 'leaf') continue;

    if (kind === 'shape') {
      rootSlots(field as Shape, at, out);
    } else if (kind === 'list') {
      out.set(rootName(at), { kind: 'order' });
      out.set(`${rootName(at)}${ITEMS}`, { kind: 'items', list: field as ListField });
    } else {
      out.set(rootName(at), { kind: 'field', field });
    }
  }

  return out;
}

/** Every root type of a doc, created if needed. The undo history and the server check watch these. */
export function rootTypes(ydoc: Y.Doc, shape: Shape): Map<Y.AbstractType<any>, RootSlot> {
  const out = new Map<Y.AbstractType<any>, RootSlot>();
  for (const [name, slot] of rootSlots(shape)) out.set(rootTypeFor(ydoc, name, slot), slot);

  return out;
}

function rootTypeFor(ydoc: Y.Doc, name: string, slot: RootSlot): Y.AbstractType<any> {
  if (slot.kind === 'order') return ydoc.getArray(name);

  if (slot.kind === 'field' && kindOf(slot.field) === 'text') return ydoc.getText(name);

  if (slot.kind === 'field' && kindOf(slot.field) === 'rich-text') return ydoc.getXmlFragment(name);

  return ydoc.getMap(name);
}

/**
 * The IDs of a list, in order: each once, at its first place, and only those that still
 * have an item. Two people who move one item at once can leave its ID twice in `order`, and
 * someone who deletes an item while another moves it can leave an ID with no item.
 */
export function liveIds(parts: ListParts): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of parts.order.toArray()) {
    if (seen.has(id)) continue;

    seen.add(id);
    if (parts.items.has(id)) out.push(id);
  }

  return out;
}
