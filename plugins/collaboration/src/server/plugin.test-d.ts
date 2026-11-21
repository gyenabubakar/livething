import { doc, text } from '~/schema.ts';
import { collaboration } from '~/server/plugin.ts';
import { taskBoard } from '~/test/task-board.ts';
import { describe, expectTypeOf, it } from 'vitest';
import type { CollaborationApi } from '~/server/plugin.ts';

const meetingNotes = doc('meeting-notes', { body: text() });

declare const api: CollaborationApi<readonly [typeof taskBoard, typeof meetingNotes]>;

describe('collaboration() types', () => {
  it('types a version by its doc type', async () => {
    const notes = api.doc('meeting-notes', 'standup');

    expectTypeOf((await notes.versions.read('v1')).body).toEqualTypeOf<string>();
    // @ts-expect-error a meeting note has no title
    void (await notes.versions.read('v1')).title;
  });

  it('narrows the onSave state and the access doc by the doc type', () => {
    collaboration({
      docs: [taskBoard, meetingNotes],
      access(_ctx, ref) {
        if (ref.type === 'meeting-notes') expectTypeOf(ref.id).toEqualTypeOf<string>();

        return 'edit';
      },
      onSave(_ctx, event) {
        if (event.type === 'meeting-notes') {
          expectTypeOf(event.state.body).toEqualTypeOf<string>();
          return;
        }

        expectTypeOf(event.type).toEqualTypeOf<'task-board'>();
        expectTypeOf(event.state.title).toEqualTypeOf<string>();
      },
    });
  });

  it('narrows the onLoad state and change by the doc type', () => {
    collaboration({
      docs: [taskBoard, meetingNotes],
      access: () => 'edit',
      onLoad(_ctx, loaded) {
        expectTypeOf(loaded.empty).toEqualTypeOf<boolean>();
        if (loaded.type === 'meeting-notes') {
          loaded.change((d) => {
            d.body = 'Agenda';
          });
          // @ts-expect-error a meeting note has no title
          loaded.change((d) => void (d.title = 'Agenda'));
          return;
        }

        expectTypeOf(loaded.state.title).toEqualTypeOf<string>();
        expectTypeOf(loaded.change(() => 3)).toEqualTypeOf<number>();
      },
    });
  });
});
