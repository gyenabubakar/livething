import { setText, toWellFormed } from '~/doc/values.ts';
import type * as Y from 'yjs';

/** What `bindText` needs from an input: an `<input>` or a `<textarea>` has it all. */
export interface TextInput {
  value: string;
  readonly selectionStart: number | null;
  readonly selectionEnd: number | null;
  setSelectionRange(start: number, end: number): void;
  addEventListener(type: TextInputEvent, listener: () => void): void;
  removeEventListener(type: TextInputEvent, listener: () => void): void;
}

type TextInputEvent = 'input' | 'compositionstart' | 'compositionend';

/** The doc a binding edits, through `change()`. */
interface EditableDoc {
  change(mutate: () => void): unknown;
}

type Delta = readonly { insert?: unknown; retain?: number; delete?: number }[];

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Where `index` of the text before `delta` is in the text after it. */
function moveIndex(index: number, delta: Delta, rangeEnd = false): number {
  let before = 0;
  let moved = index;
  for (const op of delta) {
    if (before > index) break;

    if (op.retain !== undefined) {
      before += op.retain;
    } else if (op.insert !== undefined) {
      // Text typed right at the cursor goes before it, as when someone types there. At the
      // end of a range it goes after, so a replace of the range keeps it.
      if (rangeEnd && before === index) continue;

      moved += typeof op.insert === 'string' ? op.insert.length : 1;
    } else if (op.delete !== undefined) {
      moved -= Math.min(op.delete, Math.max(0, index - before));
      before += op.delete;
    }
  }

  return moved;
}

/**
 * Keep `input` and `ytext` in step. Typing goes in as a `change()` of the doc (one undo step
 * each), and an edit from someone else, or an undo, updates the input with its cursor kept
 * on the same character.
 */
export function bindText(input: TextInput, ytext: Y.Text, doc: EditableDoc): () => void {
  input.value = ytext.toString();
  /**
   * While an IME composes (Japanese, Chinese, Korean...), setting `input.value` would cancel
   * it. So the input is left alone: what it showed when the composition began, and the
   * edits from others since, wait for the composition to end.
   */
  let composing: { shown: string; deltas: Delta[] } | null = null;

  function edit(write: () => void) {
    try {
      doc.change(write);
    } catch (error) {
      // A change the doc refused, such as one in a doc this client may only view.
      input.value = ytext.toString();
      throw error;
    }
  }

  function onInput() {
    if (composing) return;

    // Half of an emoji alone (from a paste, or a `maxlength` cut) can't be stored as it is:
    // store it as U+FFFD, as every other copy would get it, and show the input the same.
    const text = toWellFormed(input.value);
    if (text !== input.value) {
      const start = input.selectionStart;
      const end = input.selectionEnd;
      input.value = text;
      if (start !== null && end !== null) input.setSelectionRange(start, end);
    }

    edit(() => setText(ytext, text));
  }

  function onCompositionStart() {
    // A second start before an end keeps the first one's state, so its text is not lost.
    composing ??= { shown: input.value, deltas: [] };
  }

  /** Put the composed text in, at its place after the edits others made meanwhile. */
  function onCompositionEnd() {
    if (!composing) return;

    const { shown, deltas } = composing;
    composing = null;
    const typed = toWellFormed(input.value);
    let start = 0;
    while (start < shown.length && start < typed.length && shown[start] === typed[start]) {
      start += 1;
    }

    let tail = 0;
    while (
      tail < shown.length - start &&
      tail < typed.length - start &&
      shown[shown.length - 1 - tail] === typed[typed.length - 1 - tail]
    ) {
      tail += 1;
    }

    // The match counts UTF-16 units, so 😀 → 😁 would keep the shared first half and change
    // only the second: a lone half in the doc. Never start or end the change inside a pair.
    if (start > 0 && isHighSurrogate(shown.charCodeAt(start - 1))) start -= 1;
    if (tail > 0 && isLowSurrogate(shown.charCodeAt(shown.length - tail))) tail -= 1;

    const from = deltas.reduce((index, delta) => moveIndex(index, delta), start);
    const to = deltas.reduce((index, delta) => moveIndex(index, delta, true), shown.length - tail);
    const inserted = typed.slice(start, typed.length - tail);
    edit(() => {
      if (to > from) ytext.delete(from, to - from);
      if (inserted) ytext.insert(from, inserted);
    });

    const text = ytext.toString();
    if (input.value === text) return;

    // Nothing composed: keep the cursor on its character. Else put it after the new text.
    const cursor =
      typed === shown
        ? deltas.reduce((index, delta) => moveIndex(index, delta), input.selectionStart ?? 0)
        : from + inserted.length;
    input.value = text;
    input.setSelectionRange(cursor, cursor);
  }

  function onChange(event: Y.YTextEvent) {
    const delta = event.delta as Delta;
    if (composing) {
      composing.deltas.push(delta);
      return;
    }

    const text = ytext.toString();
    if (input.value === text) return;

    const start = input.selectionStart;
    const end = input.selectionEnd;
    input.value = text;
    if (start !== null && end !== null) {
      input.setSelectionRange(moveIndex(start, delta), moveIndex(end, delta));
    }
  }

  input.addEventListener('input', onInput);
  input.addEventListener('compositionstart', onCompositionStart);
  input.addEventListener('compositionend', onCompositionEnd);
  ytext.observe(onChange);

  return () => {
    input.removeEventListener('input', onInput);
    input.removeEventListener('compositionstart', onCompositionStart);
    input.removeEventListener('compositionend', onCompositionEnd);
    ytext.unobserve(onChange);
  };
}
