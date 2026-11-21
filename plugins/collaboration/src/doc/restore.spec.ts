import { restoreFrom } from '~/doc/restore.ts';
import { doc } from '~/schema.ts';
import { ids, open, seed, task, taskBoard } from '~/test/task-board.ts';
import * as v from 'valibot';
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

  it('changes rich text node by node, so anchors on words that did not change stay', () => {
    const board = seed();
    const notes = board.yjs.at((p) => p.tasks[0]?.notes);
    const paragraphs = ['Agenda for Thursday', 'Room 4', 'Bring the floor plan'].map((line) => {
      const paragraph = new Y.XmlElement('paragraph');
      paragraph.insert(0, [new Y.XmlText(line)]);
      return paragraph;
    });
    board.change(() => notes.insert(0, paragraphs));
    const version = versionOf(board);
    // "Agenda for Thursday\nRoom 4\nBring the floor plan"
    const agenda = board.anchor.text((p) => p.tasks[0]?.notes, { from: 0, to: 6 });
    const room = board.anchor.text((p) => p.tasks[0]?.notes, { from: 20, to: 24 });

    board.change(() => {
      (paragraphs[1]!.get(0) as Y.XmlText).insert(6, ', second floor');
      paragraphs[0]!.setAttribute('textAlignment', 'center');
      const heading = new Y.XmlElement('heading');
      heading.insert(0, [new Y.XmlText('Launch')]);
      notes.insert(0, [heading]);
    });
    board.change(() => restoreFrom(board.yjs.doc, version, taskBoard));

    expect(board.state.get().tasks[0]!.notes).toBe(
      'Agenda for Thursday\nRoom 4\nBring the floor plan',
    );
    expect(paragraphs[0]!.getAttributes()).toEqual({});
    expect(board.anchor.watch(agenda).get()).toEqual({ from: 0, to: 6, text: 'Agenda' });
    expect(board.anchor.watch(room).get()).toEqual({ from: 20, to: 24, text: 'Room' });
  });

  it('gives back the version exactly after any mix of rich text edits', () => {
    let seedValue = 7;
    function random(below: number): number {
      seedValue = (seedValue * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seedValue % below;
    }

    const words = ['Agenda', 'Room 4', 'Bring the plan', ''];
    function block(): Y.XmlElement {
      const element = new Y.XmlElement(random(3) === 0 ? 'heading' : 'paragraph');
      element.insert(0, [new Y.XmlText(words[random(words.length)])]);
      return element;
    }

    for (let round = 0; round < 150; round += 1) {
      const board = seed();
      const notes = board.yjs.at((p) => p.tasks[0]?.notes);
      board.change(() => notes.insert(0, [block(), block(), block(), block()]));
      const version = versionOf(board);
      const expected = notes.toJSON();

      board.change(() => {
        for (let edit = 0; edit < 1 + random(5); edit += 1) {
          const index = random(notes.length + 1);
          const node = notes.get(Math.min(index, notes.length - 1)) as Y.XmlElement | undefined;
          const text = node?.get(0) as Y.XmlText | undefined;
          const kind = random(5);
          if (kind === 0 || !node) notes.insert(index, [block()]);
          else if (kind === 1) notes.delete(Math.min(index, notes.length - 1), 1);
          else if (kind === 2) text?.insert(random(text.length + 1), 'new ');
          else if (kind === 3) node.setAttribute('textAlignment', 'center');
          else if (text && text.length > 0) text.format(0, 1 + random(text.length), { bold: true });
        }
      });
      board.change(() => restoreFrom(board.yjs.doc, version, taskBoard));

      expect(notes.toJSON()).toBe(expected);
    }
  });

  it('tells [undefined] and [null] apart when it restores a value', () => {
    const loose = doc('loose', { extra: v.optional(v.any(), null) });
    const board = open(loose);
    board.change((d) => void (d.extra = [undefined]));
    const version = new Y.Doc();
    Y.applyUpdate(version, Y.encodeStateAsUpdate(board.ydoc));

    board.change((d) => void (d.extra = [null]));
    board.change(() => restoreFrom(board.yjs.doc, version, loose));

    expect(board.state.get().extra).toEqual([undefined]);
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
