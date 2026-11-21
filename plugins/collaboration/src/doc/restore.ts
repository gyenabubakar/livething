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

/** Deep equality of stored values. Unlike a JSON compare, `undefined` and `null` differ. */
function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;

  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;

  // A Yjs type embedded in rich text points back at its doc: only the same one is equal.
  if (a instanceof Y.AbstractType || b instanceof Y.AbstractType) return false;

  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    return (
      a instanceof Uint8Array &&
      b instanceof Uint8Array &&
      a.length === b.length &&
      a.every((byte, index) => byte === b[index])
    );
  }

  if (Array.isArray(a) !== Array.isArray(b)) return false;

  const keys = Object.keys(a);

  return (
    keys.length === Object.keys(b).length &&
    keys.every(
      (key) =>
        Object.hasOwn(b, key) &&
        sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    )
  );
}

/** Rich text as plain data, with embeds and marks, which `toString()` leaves out. */
function xmlData(node: Y.XmlFragment | Y.XmlElement | Y.XmlText): unknown {
  if (node instanceof Y.XmlText) return node.toDelta();

  const children = (node.toArray() as (Y.XmlElement | Y.XmlText)[]).map(xmlData);
  return node instanceof Y.XmlElement ? [node.nodeName, node.getAttributes(), children] : children;
}

/** The characters of a text's runs, or `null` when it holds an embed. */
function plainText(runs: readonly Run[]): string | null {
  return runs.every((op) => typeof op.insert === 'string')
    ? runs.map((op) => op.insert).join('')
    : null;
}

/**
 * Make a text (or a text node of rich text) hold the version's runs. A character diff, so
 * anchors on words that did not change stay. Then the format marks (such as bold): each run
 * of the version gets its marks, and a mark the version does not have there is removed.
 */
function matchText(target: Y.Text, source: Y.Text): void {
  const runs = source.toDelta() as Run[];
  const current = target.toDelta() as Run[];
  if (sameValue(current, runs)) return;

  const next = plainText(runs);
  const now = plainText(current);
  if (next === null || now === null) {
    // An embed, such as an image: copy the version's runs as they are.
    target.delete(0, target.length);
    target.applyDelta(runs);
    return;
  }

  setText(target, next, now);
  const marks = new Set<string>();
  for (const op of target.toDelta() as Run[]) {
    for (const key of Object.keys(op.attributes ?? {})) marks.add(key);
  }

  let index = 0;
  for (const op of runs) {
    const length = (op.insert as string).length;
    const cleared = Object.fromEntries([...marks].map((key) => [key, null]));
    target.format(index, length, { ...cleared, ...op.attributes });
    index += length;
  }
}

/** Index pairs of `a` and `b` that a longest common subsequence by `same` keeps, in order. */
function commonPairs<A, B>(
  a: readonly A[],
  b: readonly B[],
  same: (x: A, y: B) => boolean,
): [number, number][] {
  // ponytail: O(a·b) time and memory, fine for the paragraphs of a doc; a diff such as Myers if docs reach many thousands.
  const width = b.length + 1;
  const lengths = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lengths[i * width + j] = same(a[i]!, b[j]!)
        ? lengths[(i + 1) * width + j + 1]! + 1
        : Math.max(lengths[(i + 1) * width + j]!, lengths[i * width + j + 1]!);
    }
  }

  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (same(a[i]!, b[j]!)) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (lengths[(i + 1) * width + j]! >= lengths[i * width + j + 1]!) {
      i += 1;
    } else {
      j += 1;
    }
  }

  return pairs;
}

/** Doc schemas hold no XmlHook, so every rich text node is an element or text. */
type XmlNode = Y.XmlElement | Y.XmlText;

/** Whether `target` can be changed into `source` in place: text, or elements of one name. */
function sameKind(target: XmlNode, source: XmlNode): boolean {
  if (target instanceof Y.XmlElement) {
    return source instanceof Y.XmlElement && target.nodeName === source.nodeName;
  }

  return source instanceof Y.XmlText && !holdsType(target) && !holdsType(source);
}

/** A Yjs type embedded in a text can't be copied by its runs, only with its node. */
function holdsType(node: Y.XmlText): boolean {
  return (node.toDelta() as Run[]).some((op) => op.insert instanceof Y.AbstractType);
}

function matchNode(target: XmlNode, source: XmlNode): void {
  if (target instanceof Y.XmlText) {
    matchText(target, source as Y.XmlText);
    return;
  }

  const attributes = (source as Y.XmlElement).getAttributes();
  for (const key of Object.keys(target.getAttributes())) {
    if (!Object.hasOwn(attributes, key)) target.removeAttribute(key);
  }

  for (const [key, value] of Object.entries(attributes) as [string, unknown][]) {
    if (sameValue(target.getAttribute(key), value)) continue;

    target.setAttribute(key, (value instanceof Y.AbstractType ? value.clone() : value) as never);
  }

  matchNodes(target, source as Y.XmlElement);
}

/**
 * Make rich text hold the version's nodes, node by node. A node that is the same stays as it
 * is. Between those, a node of the same kind is changed in place, so the words in it that did
 * not change keep their anchors. Every other node is removed, or copied from the version.
 */
function matchNodes(target: Y.XmlFragment, source: Y.XmlFragment): void {
  const current = target.toArray() as XmlNode[];
  const wanted = source.toArray() as XmlNode[];
  const kept = commonPairs(current.map(xmlData), wanted.map(xmlData), sameValue);
  let at = 0;
  let i = 0;

  let j = 0;

  function replace(untilI: number, untilJ: number) {
    target.delete(at, untilI - i);
    i = untilI;
    const added = wanted.slice(j, untilJ).map((node) => node.clone());
    target.insert(at, added);
    at += added.length;

    j = untilJ;
  }

  for (const [keptI, keptJ] of [...kept, [current.length, wanted.length] as const]) {
    const gap = commonPairs(current.slice(i, keptI), wanted.slice(j, keptJ), sameKind);
    const gapStart = [i, j] as const;
    for (const [inGapI, inGapJ] of gap) {
      const gapI = gapStart[0] + inGapI;
      const gapJ = gapStart[1] + inGapJ;
      replace(gapI, gapJ);
      matchNode(current[gapI]!, wanted[gapJ]!);
      at += 1;

      i += 1;
      j += 1;
    }

    replace(keptI, keptJ);
    at += 1;
    i += 1;
    j += 1;
  }
}

/** Make `target` hold what `source` holds, changing only what differs. */
function match(target: Y.AbstractType<any>, source: Y.AbstractType<any>): void {
  if (target instanceof Y.XmlFragment) {
    matchNodes(target, source as Y.XmlFragment);
    return;
  }

  if (target instanceof Y.Text) {
    matchText(target, source as Y.Text);
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
