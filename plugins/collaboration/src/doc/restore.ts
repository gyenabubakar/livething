import { rootTypes } from '~/doc/layout.ts';
import { setText } from '~/doc/values.ts';
import * as Y from 'yjs';
import type { DocDef } from '~/schema.ts';

function sameValue(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/** Make `target` hold what `source` holds, changing only what differs. */
function match(target: Y.AbstractType<any>, source: Y.AbstractType<any>): void {
  // Rich text: put copies of the version's nodes in place of the current ones.
  if (target instanceof Y.XmlFragment) {
    if (target.toString() === source.toString()) return;

    target.delete(0, target.length);
    // Doc schemas hold no XmlHook, so every node is an element or text.
    const nodes = (source as Y.XmlFragment).toArray() as (Y.XmlElement | Y.XmlText)[];
    target.insert(
      0,
      nodes.map((node) => node.clone()),
    );
    return;
  }

  // Text: a character diff, so anchors on words that did not change stay.
  if (target instanceof Y.Text) {
    setText(target, source.toString());
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
 * Make the doc in `target` hold what `source` (a saved version of it) holds. Call it inside
 * a change, so it is one step: one undo step and one update. List items keep their IDs, so
 * anchors on items that are still there stay on them.
 */
export function restoreFrom(target: Y.Doc, source: Y.Doc, def: DocDef): void {
  const targets = [...rootTypes(target, def.shape).keys()];
  const sources = [...rootTypes(source, def.shape).keys()];
  for (const [index, type] of targets.entries()) match(type, sources[index]!);
}
