// Huddle's shared docs: the task board each room has, as `shared/huddle-docs.ts` on the
// Huddle reference page shows it.
import { doc, list, record, richText, text } from '@livething/plugin-collaboration';
import * as v from 'valibot';

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

export const huddleDocs = [taskBoard] as const;
