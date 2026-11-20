import { restoreFrom } from '~/doc/restore.ts';
import { ids, seed, task, taskBoard } from '~/test/task-board.ts';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

/** A copy of `board` as it is now: what a saved version holds. */
function versionOf(board: ReturnType<typeof seed>): Y.Doc {
  const version = new Y.Doc();
  Y.applyUpdate(version, Y.encodeStateAsUpdate(board.ydoc));
  return version;
}

describe('restoreFrom', () => {
  it('brings back every field of a version in one change', () => {
    const board = seed();
    board.change((d) => {
      d.tasks.at(0)!.done = true;
      d.settings.set('u_amara', { collapsed: ['done'] });
    });
    const saved = board.state.get();
    const version = versionOf(board);

    board.change((d) => {
      d.title = 'Something else';
      d.archived = true;
      d.tasks.delete(0, 1);
      d.tasks.push(task('t9'));
      d.tasks.move(0, 2);

      d.settings.delete('u_amara');
      d.settings.set('u_kofi', { collapsed: [] });
    });
    board.change(() => restoreFrom(board.yjs.doc, version, taskBoard));

    expect(board.state.get()).toEqual(saved);
  });

  it('keeps the IDs of list items that are still there, so their anchors stay', () => {
    const board = seed();
    const version = versionOf(board);
    const anchor = board.anchor.item((p) => p.tasks[1]);
    const keyBefore = board.keyOf(board.state.get().tasks[1]!);

    board.change((d) => d.tasks.move(1, 0));
    board.change(() => restoreFrom(board.yjs.doc, version, taskBoard));

    expect(ids(board)).toEqual(['t1', 't2', 't3']);
    expect(board.keyOf(board.state.get().tasks[1]!)).toBe(keyBefore);
    expect(board.anchor.watch(anchor).get()).toMatchObject({ index: 1 });
  });

  it('brings back rich text', () => {
    const board = seed();
    board.change(() => {
      const notes = board.yjs.at((p) => p.tasks[0]?.notes);
      const paragraph = new Y.XmlElement('paragraph');
      notes.insert(0, [paragraph]);
      paragraph.insert(0, [new Y.XmlText('Agenda')]);
    });
    const version = versionOf(board);

    board.change(() => {
      const notes = board.yjs.at((p) => p.tasks[0]?.notes);
      notes.delete(0, notes.length);
    });
    board.change(() => restoreFrom(board.yjs.doc, version, taskBoard));

    expect(board.state.get().tasks[0]!.notes).toBe('Agenda');
  });

  it('brings back the format marks of a text field, and removes ones added since', () => {
    const board = seed();
    const title = board.yjs.at((p) => p.title);
    board.change(() => title.format(0, 3, { bold: true }));
    const version = versionOf(board);

    board.change(() => {
      title.format(0, 3, { bold: null });
      title.format(3, 3, { italic: true });
    });
    board.change(() => restoreFrom(board.yjs.doc, version, taskBoard));

    expect(title.toDelta()).toEqual([
      { insert: 'Lau', attributes: { bold: true } },
      { insert: 'nch' },
    ]);
  });

  it('brings back a rich text embed that changed since the version', () => {
    const board = seed();
    let embedded!: Y.XmlText;
    board.change(() => {
      const notes = board.yjs.at((p) => p.tasks[0]?.notes);
      embedded = new Y.XmlText();
      notes.insert(0, [embedded]);
      embedded.insertEmbed(0, { src: 'floor-plan-v1.png' });
    });
    const version = versionOf(board);

    board.change(() => {
      embedded.delete(0, 1);
      embedded.insertEmbed(0, { src: 'floor-plan-v2.png' });
    });
    board.change(() => restoreFrom(board.yjs.doc, version, taskBoard));

    const notes = board.yjs.at((p) => p.tasks[0]?.notes);
    expect((notes.get(0) as Y.XmlText).toDelta()).toEqual([
      { insert: { src: 'floor-plan-v1.png' } },
    ]);
  });

  it('is one undo step, so undo brings back what the restore replaced', () => {
    const board = seed();
    const version = versionOf(board);
    board.change((d) => {
      d.title = 'Draft';
    });
    const draft = board.state.get();

    board.change(() => restoreFrom(board.yjs.doc, version, taskBoard));
    board.history.undo();

    expect(board.state.get()).toEqual(draft);
  });
});
