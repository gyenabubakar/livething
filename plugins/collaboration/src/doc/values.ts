import { LiveThingError } from '@livething/core';
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

const MAX_DEPTH = 64;

/**
 * Check a stored value with its schema and give the schema's output. A doc stores what was
 * written (the schema's input), and a snapshot shows the output: defaults filled in, and any
 * transform run. So the server can check a stored value with the same schema.
 */
export function readValue(schema: Leaf, stored: unknown, path: string): unknown {
  if (!isStorable(stored, 0)) {
    throw invalidChange(
      path,
      `a value must be JSON or bytes, at most ${MAX_DEPTH} levels deep: null, a boolean, a finite number, a string, a Uint8Array, an array or a plain object of these`,
    );
  }

  const result = schema['~standard'].validate(stored);
  if (result instanceof Promise) {
    result.catch(() => {});
    throw invalidChange(
      path,
      'its schema checks asynchronously, so a change to it cannot be checked at once',
    );
  }

  if (result.issues) throw invalidChange(path, result.issues[0]?.message ?? 'invalid value');

  return result.value;
}

/** Check a value that is about to be written, and give what to store. */
export function writeValue(schema: Leaf, input: unknown, path: string): unknown {
  readValue(schema, input, path);
  return input;
}

/** JSON or bytes, as a Yjs update can carry it. `undefined` stands for "no value". */
export function isStorable(value: unknown, depth: number): boolean {
  if (depth > MAX_DEPTH) return false;

  if (value === null || value === undefined) return true;

  switch (typeof value) {
    case 'boolean':
    case 'string':
      return true;

    case 'number':
      return Number.isFinite(value);

    case 'object':
      // Yjs takes a plain Uint8Array only: not a subclass such as a Node Buffer.
      if (value instanceof Uint8Array) return Object.getPrototypeOf(value) === Uint8Array.prototype;

      if (Array.isArray(value)) return value.every((item) => isStorable(item, depth + 1));

      if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;

      return Object.values(value).every((item) => isStorable(item, depth + 1));

    default:
      return false;
  }
}

/**
 * Make a text equal to `next` by a character diff, so the characters that stay keep their
 * Yjs items. Another person's edit made at the same time then merges, and anchors on the
 * unchanged words stay.
 */
export function setText(ytext: Y.Text, next: string): void {
  const current = ytext.toString();
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
 * The plain text of rich text: each top-level block on its own line. `runs` lists every
 * text node with its start, so a range of the plain text maps to nodes and back.
 */
export function richTextLayout(fragment: Y.XmlFragment): { text: string; runs: TextRun[] } {
  const parts: string[] = [];
  const runs: TextRun[] = [];
  let length = 0;

  function walk(node: Y.XmlElement | Y.XmlText): void {
    if (node instanceof Y.XmlText) {
      runs.push({ node, start: length });
      const delta = node.toDelta() as { insert: unknown }[];
      for (const op of delta) {
        const piece = typeof op.insert === 'string' ? op.insert : EMBED;
        parts.push(piece);
        length += piece.length;
      }

      return;
    }

    for (const child of node.toArray()) walk(child as Y.XmlElement | Y.XmlText);
  }

  fragment.toArray().forEach((block, index) => {
    if (index > 0) {
      parts.push('\n');
      length += 1;
    }

    walk(block as Y.XmlElement | Y.XmlText);
  });

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
