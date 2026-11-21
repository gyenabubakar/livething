import { open, seed, sync, task, taskBoard, twoOffline } from '~/test/task-board.ts';
import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

/** Give a task's notes two paragraphs: "Agenda for Thursday" and "Room 4". */
function writeNotes(board: ReturnType<typeof seed>) {
  const notes = board.yjs.at((p) => p.tasks[0]?.notes);
  const first = new Y.XmlElement('paragraph');
  const second = new Y.XmlElement('paragraph');
  notes.insert(0, [first, second]);
  first.insert(0, [new Y.XmlText('Agenda for Thursday')]);

  second.insert(0, [new Y.XmlText('Room 4')]);

  return { notes, first, second };
}

describe('text anchors', () => {
  it('stay on their words through typing before them and a move of the task', () => {
    const board = seed();
    const anchor = board.anchor.text((p) => p.tasks[0]?.title, { from: 6, to: 11 });
    board.change((d) => {
      d.tasks.at(0)!.title = 'Please write the notes today';
      d.tasks.move(0, 2);
    });

    expect(board.anchor.watch(anchor).get()).toEqual({ from: 17, to: 22, text: 'notes' });
  });

  it('are plain JSON that another copy resolves', () => {
    const { amara, kofi, sync } = twoOffline();
    const anchor = JSON.parse(
      JSON.stringify(amara.anchor.text((p) => p.tasks[1]?.title, { from: 5, to: 9 })),
    );
    kofi.change((d) => void (d.tasks.at(1)!.title = 'Please book room'));
    sync();

    expect(kofi.anchor.watch(anchor).get()).toEqual({ from: 12, to: 16, text: 'room' });
  });

  it('resolve to null once all their words are deleted', () => {
    const board = seed();
    const anchor = board.anchor.text((p) => p.tasks[0]?.title, { from: 6, to: 11 });
    board.change((d) => void (d.tasks.at(0)!.title = 'Write'));

    expect(board.anchor.watch(anchor).get()).toBeNull();
  });

  it('resolve to null once the task that holds them is deleted', () => {
    const board = seed();
    const anchor = board.anchor.text((p) => p.tasks[0]?.title, { from: 0, to: 5 });
    board.change((d) => d.tasks.delete(0));

    expect(board.anchor.watch(anchor).get()).toBeNull();
  });

  it('work in rich text, by offsets in its plain text, across blocks', () => {
    const board = seed();
    const { first } = writeNotes(board);
    // "Agenda for Thursday\nRoom 4": "Thursday\nRoom" spans both blocks.
    const anchor = board.anchor.text((p) => p.tasks[0]?.notes, { from: 11, to: 24 });

    expect(board.anchor.watch(anchor).get()).toEqual({ from: 11, to: 24, text: 'Thursday\nRoom' });

    (first.get(0) as Y.XmlText).insert(0, 'Draft: ');

    expect(board.anchor.watch(anchor).get()).toEqual({
      from: 18,
      to: 31,
      text: 'Thursday\nRoom',
    });
  });

  it('trim a rich text range that starts on a line break, and refuse one that holds only that', () => {
    const board = seed();
    writeNotes(board);
    // "Agenda for Thursday\nRoom 4": the line break is at 19.
    const anchor = board.anchor.text((p) => p.tasks[0]?.notes, { from: 19, to: 24 });

    expect(board.anchor.watch(anchor).get()).toEqual({ from: 20, to: 24, text: 'Room' });
    expect(() => board.anchor.text((p) => p.tasks[0]?.notes, { from: 19, to: 20 })).toThrow(
      /holds only line breaks/,
    );
  });

  it('stay on their words when an empty block next to them is deleted', () => {
    const board = seed();
    const notes = board.yjs.at((p) => p.tasks[0]?.notes);
    const blocks = ['Hello', '', 'World'].map((line) => {
      const paragraph = new Y.XmlElement('paragraph');
      paragraph.insert(0, [new Y.XmlText(line)]);
      return paragraph;
    });
    board.change(() => notes.insert(0, blocks));
    // "Hello\n\nWorld": the range starts on the line break before the empty block.
    const anchor = board.anchor.text((p) => p.tasks[0]?.notes, { from: 5, to: 12 });

    board.change(() => notes.delete(1, 1));

    expect(board.anchor.watch(anchor).get()).toEqual({ from: 6, to: 11, text: 'World' });
  });

  it('refuse a range that is empty or out of the text', () => {
    const board = seed();
    expect(() => board.anchor.text((p) => p.tasks[0]?.title, { from: 3, to: 3 })).toThrow(
      RangeError,
    );
    expect(() => board.anchor.text((p) => p.tasks[0]?.title, { from: 0, to: 99 })).toThrow(
      RangeError,
    );
    expect(() => board.anchor.text((p) => p.tasks[0] as never, { from: 0, to: 1 })).toThrow(
      /text\(\) or richText\(\)/,
    );
  });
});

describe('item anchors', () => {
  it('stay on a task through moves, and resolve to null once it is deleted', () => {
    const board = seed();
    const anchor = board.anchor.item((p) => p.tasks[0]);
    const key = board.keyOf(board.state.get().tasks[0]!);

    board.change((d) => d.tasks.move(0, 2));

    expect(board.anchor.watch(anchor).get()).toEqual({ key, index: 2 });

    board.change((d) => d.tasks.delete(2));

    expect(board.anchor.watch(anchor).get()).toBeNull();
  });

  it('stay on a task that two people move at once, and resolve the same on both copies', () => {
    const { amara, kofi, sync } = twoOffline();
    const anchor = JSON.parse(JSON.stringify(amara.anchor.item((p) => p.tasks[0])));
    amara.change((d) => d.tasks.move(0, 2));
    kofi.change((d) => d.tasks.move(0, 1));
    sync();

    expect(amara.anchor.watch(anchor).get()).toEqual(kofi.anchor.watch(anchor).get());
    expect(amara.anchor.watch(anchor).get()).not.toBeNull();
  });

  it('work on a record entry', () => {
    const board = seed();
    board.change((d) => d.settings.set('u_amara', { collapsed: [] }));
    const anchor = board.anchor.item((p) => p.settings['u_amara']);

    expect(board.anchor.watch(anchor).get()).toEqual({ key: 'u_amara', index: null });

    board.change((d) => d.settings.delete('u_amara'));

    expect(board.anchor.watch(anchor).get()).toBeNull();
  });

  it('refuse a path that does not end at an item', () => {
    const board = seed();
    expect(() => board.anchor.item((p) => p.title as never)).toThrow(/list item or a record entry/);
  });
});

describe('anchor.watch()', () => {
  it('notifies when the place changes, and not for other changes', () => {
    const board = seed();
    const place = board.anchor.watch(board.anchor.item((p) => p.tasks[1]));
    const listener = vi.fn();
    place.subscribe(listener);

    board.change((d) => void (d.title = 'Launch v2'));

    expect(listener).not.toHaveBeenCalled();

    board.change((d) => d.tasks.insert(0, task('t0')));

    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ index: 2 }));
  });

  it('works for an anchor made before its words arrive on this copy', () => {
    const amara = seed();
    const kofi = open(taskBoard);
    const anchor = amara.anchor.text((p) => p.tasks[0]?.title, { from: 0, to: 5 });
    const place = kofi.anchor.watch(anchor);
    const listener = vi.fn();

    place.subscribe(listener);

    expect(place.get()).toBeNull();

    sync(amara.ydoc, kofi.ydoc);

    expect(listener).toHaveBeenCalledWith({ from: 0, to: 5, text: 'Write' });
  });
});
