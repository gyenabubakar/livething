import { rootTypes } from '~/doc/layout.ts';
import { Snapshots } from '~/doc/snapshot.ts';
import { setText } from '~/doc/values.ts';
import * as Y from 'yjs';
import type { DocDef } from '~/schema.ts';

/** One run of a text's delta: its characters (or an embed) and their format marks. */
interface Run {
  readonly insert: unknown;
  readonly attributes?: Record<string, unknown>;
}

function sameValue(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/** Rich text as plain data, with embeds and marks, which `toString()` leaves out. */
function xmlData(node: Y.XmlFragment | Y.XmlElement | Y.XmlText): unknown {
  if (node instanceof Y.XmlText) return node.toDelta();

  const children = (node.toArray() as (Y.XmlElement | Y.XmlText)[]).map(xmlData);
  return node instanceof Y.XmlElement ? [node.nodeName, node.getAttributes(), children] : children;
}

/** Make `target` hold what `source` holds, changing only what differs. */
function match(target: Y.AbstractType<any>, source: Y.AbstractType<any>): void {
  // Rich text: put copies of the version's nodes in place of the current ones.
  if (target instanceof Y.XmlFragment) {
    if (sameValue(xmlData(target), xmlData(source as Y.XmlFragment))) return;

    target.delete(0, target.length);
    // Doc schemas hold no XmlHook, so every node is an element or text.
    const nodes = (source as Y.XmlFragment).toArray() as (Y.XmlElement | Y.XmlText)[];
    target.insert(
      0,
      nodes.map((node) => node.clone()),
    );
    return;
  }

  // Text: a character diff, so anchors on words that did not change stay. Then the format
  // marks (such as bold from Quill): each run of the version gets its marks, and a mark the
  // version does not have there is removed.
  if (target instanceof Y.Text) {
    setText(target, source.toString());
    if (sameValue(target.toDelta(), (source as Y.Text).toDelta())) return;

    const marks = new Set<string>();
    for (const op of target.toDelta() as Run[]) {
      for (const key of Object.keys(op.attributes ?? {})) marks.add(key);
    }

    let index = 0;
    for (const op of (source as Y.Text).toDelta() as Run[]) {
      // A text() field holds no embeds, and `setText` copied only the characters.
      if (typeof op.insert !== 'string') continue;

      const length = op.insert.length;
      const cleared = Object.fromEntries([...marks].map((key) => [key, null]));
      target.format(index, length, { ...cleared, ...op.attributes });
      index += length;
    }

    return;
  }

  // A list order: item IDs.
  if (target instanceof Y.Array) {
    const ids = (source as Y.Array<unknown>).toArray();
    if (sameValue(target.toArray(), ids)) return;

    target.delete(0, target.length);
    target.insert(0, ids);
    return;
  }

  if (!(target instanceof Y.Map) || !(source instanceof Y.Map)) return;

  for (const key of [...target.keys()]) if (!source.has(key)) target.delete(key);

  for (const [key, value] of source.entries()) {
    const current: unknown = target.get(key);
    if (!(value instanceof Y.AbstractType)) {
      if (!sameValue(current, value)) target.set(key, value);
    } else if (current instanceof Y.AbstractType && current.constructor === value.constructor) {
      match(current, value);
    } else {
      target.set(key, value.clone());
    }
  }
}

/**
 * Throw `invalid-change` when `version` holds content the doc type's schema refuses, as when
 * the schema changed after the version was saved. Restoring it would put that content in the doc.
 */
export function checkVersion(def: DocDef, version: Y.Doc): void {
  new Snapshots(version).doc(def.shape);
}

/**
 * Make the doc in `target` hold what `source` (a saved version of it) holds. Call it inside
 * a change, so it is one step: one undo step and one update. List items keep their IDs, so
 * anchors on items that are still there stay on them.
 */
export function restoreFrom(target: Y.Doc, source: Y.Doc, def: DocDef): void {
  const targets = [...rootTypes(target, def.shape).keys()];
  const sources = [...rootTypes(source, def.shape).keys()];
  for (const [index, type] of targets.entries()) match(type, sources[index]!);
}
