import { createDocState } from '~/client/doc-state.ts';
import { DocCore } from '~/doc/core.ts';
import { doc, list, record, richText, text } from '~/schema.ts';
import * as v from 'valibot';
import * as Y from 'yjs';
import type { DocDef } from '~/schema.ts';

/** Huddle's task board, as the docs describe it. */
export const taskBoard = doc(
  'task-board',
  {
    title: text(),
    archived: v.optional(v.boolean(), false),
    columns: list({ id: v.string(), name: text() }),
    tasks: list({
      id: v.string(),
      column: v.string(),
      title: text(),
      done: v.boolean(),
      assignee: v.nullable(v.string()),
      notes: richText(),
    }),
    settings: record({ collapsed: v.array(v.string()) }),
  },
  { awareness: v.object({ viewingTaskId: v.nullable(v.string()) }) },
);

export function task(id: string, column = 'todo', title = `Task ${id}`) {
  return { id, column, title, done: false, assignee: null, notes: '' };
}

/** A client copy of a doc, with the errors it reported. */
export function open<D extends DocDef>(def: D, ydoc = new Y.Doc()) {
  const errors: unknown[] = [];
  const core = new DocCore(def, ydoc);
  return { core, ydoc, errors, ...createDocState(core, (error) => errors.push(error)) };
}

/** A board with two columns and three tasks: t1, t2 and t3. */
export function seed() {
  const board = open(taskBoard);
  board.change((d) => {
    d.title = 'Launch';
    d.columns.push({ id: 'todo', name: 'To do' }, { id: 'done', name: 'Done' });
    d.tasks.push(task('t1', 'todo', 'Write notes'), task('t2', 'todo', 'Book room'), task('t3'));
  });
  return board;
}

export function sync(a: Y.Doc, b: Y.Doc): void {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
}

/** Two copies of a seeded board that edit offline until `sync()`. */
export function twoOffline() {
  const base = seed();
  const a = new Y.Doc();
  const b = new Y.Doc();
  Y.applyUpdate(a, Y.encodeStateAsUpdate(base.ydoc));
  Y.applyUpdate(b, Y.encodeStateAsUpdate(base.ydoc));

  return { amara: open(taskBoard, a), kofi: open(taskBoard, b), sync: () => sync(a, b) };
}

/** The task IDs of a board, in order. */
export function ids(board: ReturnType<typeof open<typeof taskBoard>>): string[] {
  return board.state.get().tasks.map((t) => t.id);
}
