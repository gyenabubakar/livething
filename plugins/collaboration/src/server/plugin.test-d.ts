import { doc, text } from '~/schema.ts';
import { collaboration } from '~/server/plugin.ts';
import { taskBoard } from '~/test/task-board.ts';
import { describe, expectTypeOf, it } from 'vitest';

const meetingNotes = doc('meeting-notes', { body: text() });

describe('collaboration() types', () => {
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
});
