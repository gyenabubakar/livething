import { LiveThingError } from '@livething/core';
import { isStorable, MAX_DEPTH, wellFormed } from '~/doc/storable.ts';
import { isThenable } from '~/doc/thenable.ts';
import diff from 'fast-diff';
import * as Y from 'yjs';
import type { Leaf } from '~/schema.ts';

/** The detail of an `invalid-change` error: where in the doc, and why. */
export interface InvalidChangeDetail {
  /** The field, by schema path, such as `tasks[].done`. */
  readonly path: string;
  readonly reason: string;
}

/** A change, or stored content, that the doc's schema does not allow. */
export function invalidChange(
  path: string,
  reason: string,
): LiveThingError<'invalid-change', InvalidChangeDetail> {
  const error = new LiveThingError('invalid-change', { path, reason });
  // The code alone says nothing in a console, so the message says where and why.
  error.message = `invalid-change: '${path}': ${reason}`;
  return error;
}

/**
 * Check a stored value with its schema and give the schema's output. A doc stores what was
 * written (the schema's input), and a snapshot shows the output: defaults filled in, and any
 * transform run. So the server can check a stored value with the same schema.
 */
export function readValue(schema: Leaf, stored: unknown, path: string): unknown {
  if (!isStorable(stored, 0)) {
    throw invalidChange(
      path,
      `a value must be JSON or bytes, at most ${MAX_DEPTH} levels deep: null, a boolean, a finite number, a string with no half of an emoji alone, a Uint8Array, an array or a plain object of these`,
    );
  }

  // A copy: the output may be the very object it was given, and a snapshot freezes and hands
  // out its output, so the value Yjs holds must not be it. Bytes would stay writable.
  const result = schema['~standard'].validate(copyValue(stored));
  if (isThenable(result)) {
    Promise.resolve(result).catch(() => {});
    throw invalidChange(
      path,
      'its schema checks asynchronously, so a change to it cannot be checked at once',
    );
  }

  if (result.issues) throw invalidChange(path, result.issues[0]?.message ?? 'invalid value');

  // A snapshot freezes and copies its output, and the server compares outputs, so a Date or
  // a class instance would not survive.
  if (!isStorable(result.value, 0)) {
    throw invalidChange(path, 'its schema output must be JSON or bytes, as its input is');
  }

  return result.value;
}

/**
 * Check a value that is about to be written, and give what to store: a copy, because Yjs
 * keeps the object it gets, and the caller may change theirs later. The copy is what gets
 * checked, so a getter can't give the check one value and Yjs another.
 */
export function writeValue(schema: Leaf, input: unknown, path: string): unknown {
  const copy = isStorable(input, 0) ? copyValue(input) : input;
  readValue(schema, copy, path);
  return copy;
}

/** A deep copy of a value `isStorable` passed. Bytes are copied alone, not with the buffer they view. */
function copyValue(value: unknown): unknown {
  if (value instanceof Uint8Array) return value.slice();

  if (Array.isArray(value)) return value.map(copyValue);

  if (typeof value !== 'object' || value === null) return value;

  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) copy[key] = copyValue(item);

  return copy;
}

/** Check a string written as text, rich text or a record key, and give it back. */
export function checkString(path: string, value: unknown, what: string): string {
  if (typeof value !== 'string') throw invalidChange(path, `${what} must be a string`);

  if (!wellFormed(value)) {
    throw invalidChange(path, `${what} holds half of an emoji or other pair, alone`);
  }

  return value;
}

/**
 * Make a text equal to `next` by a character diff, so the characters that stay keep their
 * Yjs items. Another person's edit made at the same time then merges, and anchors on the
 * unchanged words stay.
 */
export function setText(ytext: Y.Text, next: string, current = ytext.toString()): void {
  if (current === next) return;

  let index = 0;
  for (const [op, chunk] of diff(current, next)) {
    if (op === diff.EQUAL) {
      index += chunk.length;
    } else if (op === diff.DELETE) {
      ytext.delete(index, chunk.length);
    } else {
      ytext.insert(index, chunk);
      index += chunk.length;
    }
  }
}

/** The character an embed (an image, a mention) counts as in plain text. */
const EMBED = '￼';

/** One piece of text inside rich text, and where it starts in the plain text. */
export interface TextRun {
  readonly node: Y.XmlText;
  readonly start: number;
}

/**
 * The plain text of rich text: each block (an element that holds text, at any depth) on its
 * own line. `runs` lists every text node with its start, so a range of the plain text maps
 * to nodes and back.
 */
export function richTextLayout(fragment: Y.XmlFragment): { text: string; runs: TextRun[] } {
  const parts: string[] = [];
  const runs: TextRun[] = [];
  let length = 0;
  let lines = 0;

  function newLine(): void {
    if (lines > 0) {
      parts.push('\n');
      length += 1;
    }

    lines += 1;
  }

  /**
   * A block is an element that holds text, or none at all, outside another block's text: a
   * paragraph or a heading, however deep an editor nests it (BlockNote, lists). Each one
   * starts a line.
   */
  function walk(node: Y.XmlElement | Y.XmlText, inText: boolean): void {
    if (node instanceof Y.XmlText) {
      if (!inText) newLine();
      runs.push({ node, start: length });
      const delta = node.toDelta() as { insert: unknown }[];
      for (const op of delta) {
        const piece = typeof op.insert === 'string' ? op.insert : EMBED;
        parts.push(piece);
        length += piece.length;
      }

      return;
    }

    const children = node.toArray() as (Y.XmlElement | Y.XmlText)[];
    const holdsText = children.some((child) => child instanceof Y.XmlText);
    if (!inText && (holdsText || children.length === 0)) newLine();
    for (const child of children) walk(child, inText || holdsText);
  }

  for (const block of fragment.toArray()) walk(block as Y.XmlElement | Y.XmlText, false);

  return { text: parts.join(''), runs };
}

/**
 * New rich text with `text` in it: one `paragraph` element per line, the node name that
 * ProseMirror, Tiptap and BlockNote use for a plain block. Empty text is an empty fragment,
 * which an editor fills with its own empty paragraph.
 */
export function richTextFrom(text: string): Y.XmlFragment {
  const fragment = new Y.XmlFragment();
  if (text === '') return fragment;

  fragment.insert(
    0,
    text.split('\n').map((line) => {
      const paragraph = new Y.XmlElement('paragraph');
      if (line !== '') paragraph.insert(0, [new Y.XmlText(line)]);
      return paragraph;
    }),
  );
  return fragment;
}
