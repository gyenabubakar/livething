import { setText } from '~/doc/values.ts';
import type * as Y from 'yjs';

/** What `bindText` needs from an input: an `<input>` or a `<textarea>` has it all. */
export interface TextInput {
  value: string;
  readonly selectionStart: number | null;
  readonly selectionEnd: number | null;
  setSelectionRange(start: number, end: number): void;
  addEventListener(type: 'input', listener: () => void): void;
  removeEventListener(type: 'input', listener: () => void): void;
}

/** The doc a binding edits, through `change()`. */
interface EditableDoc {
  change(mutate: () => void): unknown;
}

type Delta = readonly { insert?: unknown; retain?: number; delete?: number }[];

/** Where `index` of the text before `delta` is in the text after it. */
function moveIndex(index: number, delta: Delta): number {
  let before = 0;
  let moved = index;
  for (const op of delta) {
    if (before > index) break;

    if (op.retain !== undefined) {
      before += op.retain;
    } else if (op.insert !== undefined) {
      // Text typed right at the cursor goes before it, as when someone types there.
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

  function onInput() {
    try {
      doc.change(() => setText(ytext, input.value));
    } catch (error) {
      // A change the doc refused, such as one in a doc this client may only view.
      input.value = ytext.toString();
      throw error;
    }
  }

  function onChange(event: Y.YTextEvent) {
    const text = ytext.toString();
    if (input.value === text) return;

    const delta = event.delta as Delta;
    const start = input.selectionStart;
    const end = input.selectionEnd;
    input.value = text;
    if (start !== null && end !== null) {
      input.setSelectionRange(moveIndex(start, delta), moveIndex(end, delta));
    }
  }

  input.addEventListener('input', onInput);
  ytext.observe(onChange);

  return () => {
    input.removeEventListener('input', onInput);
    ytext.unobserve(onChange);
  };
}
