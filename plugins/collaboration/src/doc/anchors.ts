import { liveIds, nestedList, rootList } from '~/doc/layout.ts';
import { richTextLayout } from '~/doc/values.ts';
import * as Y from 'yjs';
import type { ListParts } from '~/doc/layout.ts';
import type { PathEnd } from '~/doc/paths.ts';

/** A Yjs relative position as JSON: it names a character or a container by its Yjs ID. */
type PositionJson = Record<string, unknown>;

/**
 * A place on some words of a `text()` or `richText()` field. It follows the words as people
 * type before them and as the item that holds them moves. Plain JSON: send it, store it.
 */
export interface TextAnchor {
  readonly kind: 'text';
  readonly start: PositionJson;
  readonly end: PositionJson;
}

/** A place on one list item or record entry. It stays on the item when the item moves. */
export interface ItemAnchor {
  readonly kind: 'item';
  /** The list's `items` map, or the record's map. */
  readonly container: PositionJson;
  readonly key: string;
  readonly list: boolean;
}

/** An anchor of either kind, as `anchor.watch()` takes it back from JSON. */
export type Anchor = TextAnchor | ItemAnchor;

/** Characters `from` to `to` of a text, the end not included. */
export interface TextRange {
  readonly from: number;
  readonly to: number;
}

/**
 * Where a text anchor's words are now: their range in the field's plain text (for rich text,
 * the text `state` shows), and the words themselves.
 */
export interface TextPlace {
  readonly from: number;
  readonly to: number;
  readonly text: string;
}

/**
 * Where an item anchor's item is now. In a list, `key` is the item's ID (as `keyOf()` gives)
 * and `index` its place. In a record, `key` is the record key and `index` is `null`.
 */
export interface ItemPlace {
  readonly key: string;
  readonly index: number | null;
}

/** A text or rich text field's plain text, and how to go between offsets and Yjs positions. */
function textOf(type: Y.AbstractType<any>) {
  if (type instanceof Y.Text) {
    return {
      text: type.toString(),
      holdsText: () => true,
      position: (offset: number, assoc: number) =>
        Y.createRelativePositionFromTypeIndex(type, offset, assoc),
    };
  }

  const fragment = type as Y.XmlFragment;
  const { text, runs } = richTextLayout(fragment);
  return {
    text,
    /** Whether `from` to `to` holds a character of some block, not only line breaks between blocks. */
    holdsText: (from: number, to: number) =>
      runs.some((run) => run.start < to && run.start + run.node.length > from),
    // An offset on a line break between blocks belongs to the next text (start) or the
    // previous one (end), so an anchor never sits on the break itself. Nor on an empty block:
    // deleting a blank line must not lose an anchor on the words next to it.
    position(offset: number, assoc: number) {
      const filled = runs.filter((r) => r.node.length > 0);
      const backwards = [...filled].reverse();
      const run =
        assoc >= 0
          ? (filled.find((r) => offset < r.start + r.node.length && offset >= r.start) ??
            filled.find((r) => r.start >= offset))
          : (backwards.find((r) => offset > r.start && offset <= r.start + r.node.length) ??
            backwards.find((r) => r.start + r.node.length <= offset));
      if (!run) return null;

      const local = Math.min(Math.max(offset - run.start, 0), run.node.length);

      return Y.createRelativePositionFromTypeIndex(run.node, local, assoc);
    },
  };
}

/** An anchor on characters `from` to `to` (end not included) of a text or rich text field. */
export function textAnchor(end: PathEnd, range: TextRange): TextAnchor {
  const type = end.type;
  if (!(type instanceof Y.Text || type instanceof Y.XmlFragment)) {
    throw new TypeError('anchor.text() needs a path to a text() or richText() field');
  }

  const { from, to } = range;
  const content = textOf(type);
  if (
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from < 0 ||
    to <= from ||
    to > content.text.length
  ) {
    throw new RangeError(
      `anchor.text() needs 0 <= from < to <= ${content.text.length}, got from ${from} and to ${to}`,
    );
  }

  // A line break between blocks is no character to anchor on: a range trims onto the
  // characters inside it, and one with none at all is refused.
  if (!content.holdsText(from, to)) {
    throw new RangeError(
      `anchor.text() got from ${from} and to ${to}, a range that holds only line breaks between blocks`,
    );
  }

  const start = content.position(from, 0);
  const stop = content.position(to, -1);
  if (!start || !stop) throw new RangeError('anchor.text() needs a range that holds some text');

  return {
    kind: 'text',
    start: Y.relativePositionToJSON(start),
    end: Y.relativePositionToJSON(stop),
  };
}

/** An anchor on the list item or record entry a path ends at. */
export function itemAnchor(end: PathEnd): ItemAnchor {
  if (end.kind === 'type') {
    throw new TypeError('anchor.item() needs a path to a list item or a record entry');
  }

  const container = end.kind === 'list-item' ? end.parts.items : end.map;
  return {
    kind: 'item',
    container: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(container, 0)),
    key: end.kind === 'list-item' ? end.id : end.key,
    list: end.kind === 'list-item',
  };
}

/** Whether a type was deleted, itself or as part of something deleted. */
function isDeleted(type: Y.AbstractType<any>): boolean {
  for (let item = type._item; item !== null; item = (item.parent as Y.AbstractType<any>)._item) {
    if (item.deleted) return true;
  }

  return false;
}

function absolute(ydoc: Y.Doc, json: PositionJson) {
  const position = Y.createAbsolutePositionFromRelativePosition(
    Y.createRelativePositionFromJSON(json),
    ydoc,
  );
  return position && !isDeleted(position.type) ? position : null;
}

/** The text or rich text field a text position is in, and its plain-text offset there. */
function offsetOf(type: Y.AbstractType<any>, index: number) {
  if (type instanceof Y.Text && !(type instanceof Y.XmlText)) return { field: type, offset: index };

  let fragment: Y.AbstractType<any> | null = type;
  while (fragment && !(fragment instanceof Y.XmlFragment && !(fragment instanceof Y.XmlElement))) {
    fragment = fragment.parent;
  }

  if (!fragment) return null;

  const run = richTextLayout(fragment as Y.XmlFragment).runs.find((r) => r.node === type);

  return run ? { field: fragment, offset: run.start + index } : null;
}

/** Where a text anchor's words are now, or `null` once they are all deleted. */
export function resolveText(ydoc: Y.Doc, anchor: TextAnchor): TextPlace | null {
  const start = absolute(ydoc, anchor.start);
  const end = absolute(ydoc, anchor.end);
  if (!start || !end) return null;

  const from = offsetOf(start.type, start.index);
  const to = offsetOf(end.type, end.index);
  if (!from || !to || from.field !== to.field || to.offset <= from.offset) return null;

  return {
    from: from.offset,
    to: to.offset,
    text: textOf(from.field).text.slice(from.offset, to.offset),
  };
}

/** The list a list's `items` map belongs to. */
function listOfItems(ydoc: Y.Doc, items: Y.Map<unknown>): ListParts | null {
  if (items.parent instanceof Y.Map) return nestedList(items.parent);

  for (const [name, type] of ydoc.share) {
    if ((type as unknown) === items && name.endsWith('#items')) {
      return rootList(ydoc, name.slice(0, -'#items'.length).split('/'));
    }
  }

  return null;
}

/** Where an item anchor's item is now, or `null` once it is deleted. */
export function resolveItem(ydoc: Y.Doc, anchor: ItemAnchor): ItemPlace | null {
  const position = absolute(ydoc, anchor.container);
  if (!position || !(position.type instanceof Y.Map)) return null;

  const map = position.type as Y.Map<unknown>;
  if (!map.has(anchor.key)) return null;

  if (!anchor.list) return { key: anchor.key, index: null };

  const parts = listOfItems(ydoc, map);
  const index = parts ? liveIds(parts).indexOf(anchor.key) : -1;

  return index === -1 ? null : { key: anchor.key, index };
}
