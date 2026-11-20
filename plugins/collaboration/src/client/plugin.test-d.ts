import { collaboration } from '~/client/plugin.ts';
import { doc, text } from '~/schema.ts';
import { taskBoard } from '~/test/task-board.ts';
import { describe, expectTypeOf, it } from 'vitest';
import type { CollaborationClient } from '~/client/plugin.ts';
import type { Access } from '~/doc/wire.ts';
import type * as Y from 'yjs';

const meetingNotes = doc('meeting-notes', { body: text() });
const HuddleCollaboration = collaboration({ docs: [taskBoard, meetingNotes] });
declare const collab: CollaborationClient<readonly [typeof taskBoard, typeof meetingNotes]>;
declare const input: HTMLInputElement;

describe('the client plugin types', () => {
  it('types a doc handle by its doc type name', () => {
    const board = collab.doc('task-board', 'launch');
    const notes = collab.doc('meeting-notes', 'standup');

    expectTypeOf(board.state.get().tasks[0]!.done).toEqualTypeOf<boolean>();
    expectTypeOf(notes.state.get().body).toEqualTypeOf<string>();
    expectTypeOf(board.access.get()).toEqualTypeOf<Access | null>();
    expectTypeOf(board.yjs.at((p) => p.title)).toEqualTypeOf<Y.Text>();

    // @ts-expect-error the server serves no 'whiteboard' docs
    collab.doc('whiteboard', 'x');
    // @ts-expect-error a meeting note has no tasks
    notes.change((d) => d.tasks);
  });

  it('types awareness by the doc type schema', () => {
    const board = collab.doc('task-board', 'launch');

    board.awareness.update({ viewingTaskId: 't1' });
    expectTypeOf(board.awareness.self.get()!.state).toEqualTypeOf<{
      viewingTaskId: string | null;
    } | null>();

    // @ts-expect-error viewingTaskId is a string or null
    board.awareness.update({ viewingTaskId: 3 });
  });

  it('binds text inputs only to text fields', () => {
    const board = collab.doc('task-board', 'launch');

    board.bindText(input, (p) => p.title);
    // @ts-expect-error `done` is a boolean, not text
    board.bindText(input, (p) => p.tasks[0]?.done);
  });

  it('types a version by its doc type', async () => {
    const notes = collab.doc('meeting-notes', 'standup');

    expectTypeOf((await notes.versions.read('v1')).body).toEqualTypeOf<string>();
    expectTypeOf((await notes.versions.list())[0]!.author).toEqualTypeOf<string | null>();
  });

  it('gives a plugin factory with use()', () => {
    expectTypeOf(HuddleCollaboration.use).toBeFunction();
  });
});
