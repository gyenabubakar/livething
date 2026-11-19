// Type-only checks for describing a doc. tsc checks these; vitest never runs them.
import { doc, list, record, richText, text } from '~/schema.ts';
import { type } from 'arktype';
import * as v from 'valibot';
import { expectTypeOf } from 'vitest';
import { z } from 'zod';
import type { DocsByName, Draft, Input, PathOf, Snapshot } from '~/schema.ts';
import type * as Y from 'yjs';

const taskBoard = doc(
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

type Board = (typeof taskBoard)['shape'];

// ---- the snapshot ----

type State = Snapshot<Board>;
type Task = State['tasks'][number];

expectTypeOf<State['title']>().toEqualTypeOf<string>();
expectTypeOf<State['archived']>().toEqualTypeOf<boolean>();
expectTypeOf<State['columns']>().toEqualTypeOf<
  readonly { readonly id: string; readonly name: string }[]
>();
expectTypeOf<Task['assignee']>().toEqualTypeOf<string | null>();
// Rich text reads as plain text, for previews.
expectTypeOf<Task['notes']>().toEqualTypeOf<string>();
expectTypeOf<State['settings'][string]['collapsed']>().toEqualTypeOf<readonly string[]>();

declare const state: State;
// @ts-expect-error — a value inside a snapshot is read-only too
state.settings['u_amara']!.collapsed.push('todo');
// @ts-expect-error — a snapshot is read-only
state.title = 'x';
// @ts-expect-error — so are its lists
state.tasks.push(state.tasks[0]!);

// ---- what a new list item takes ----

type NewTask = Input<Board['tasks']>[number];
expectTypeOf<NewTask>().toEqualTypeOf<{
  readonly id: string;
  readonly column: string;
  readonly title: string;
  readonly done: boolean;
  readonly assignee: string | null;
  readonly notes: string;
}>();

// ---- the draft that change() hands you ----

declare const d: Draft<Board>;

function edit() {
  d.title = 'Launch';
  d.archived = true;
  d.columns.push({ id: 'todo', name: 'To do' });
  d.tasks.move(0, 1);
  d.settings.set('u_amara', { collapsed: ['done'] });

  const task = d.tasks.find((t) => t.id === 't_1042');
  if (task) {
    task.done = true;
    task.title = 'Write the notes';
    // @ts-expect-error — rich text is changed through an editor, not by assigning
    task.notes = 'x';
    // @ts-expect-error — done is a boolean
    task.done = 'yes';
  }

  // A value changes as a whole: set it again, never inside it.
  const settings = d.settings.get('u_amara');
  if (settings) {
    // @ts-expect-error — a value's array is read-only
    settings.collapsed.push('todo');
  }

  // @ts-expect-error — a list is changed through its methods
  d.columns = [];
  // @ts-expect-error — a new task needs every field
  d.tasks.push({ id: 't_1043', title: 'Book a room' });
  // @ts-expect-error — no such field
  d.nope = 1;
}

void edit;

// ---- Yjs types by path, for editors ----

type Paths = PathOf<Board>;
expectTypeOf<Paths['title']>().toHaveProperty('~yjs').toEqualTypeOf<Y.Text>();
expectTypeOf<Paths['tasks'][number]['notes']>()
  .toHaveProperty('~yjs')
  .toEqualTypeOf<Y.XmlFragment>();
expectTypeOf<Paths['tasks'][number]['done']>().not.toHaveProperty('~yjs');

// ---- doc names ----

const notes = doc('notes', { body: text() });
type Docs = DocsByName<[typeof taskBoard, typeof notes]>;
expectTypeOf<keyof Docs>().toEqualTypeOf<'task-board' | 'notes'>();
expectTypeOf<Docs['notes']>().toEqualTypeOf<typeof notes>();

// ---- any Standard Schema library ----

const zodNotes = doc('notes', {
  title: text(),
  pinned: z.boolean().default(false),
  tags: list(z.enum(['urgent', 'later'])),
});
const arkNotes = doc('notes', {
  title: text(),
  pinned: type('boolean | undefined').pipe((value) => value ?? false),
  tags: list(type("'urgent' | 'later'")),
});
expectTypeOf<Snapshot<(typeof zodNotes)['shape']>['pinned']>().toEqualTypeOf<boolean>();
expectTypeOf<Snapshot<(typeof zodNotes)['shape']>['tags']>().toEqualTypeOf<
  readonly ('urgent' | 'later')[]
>();
expectTypeOf<Snapshot<(typeof arkNotes)['shape']>['pinned']>().toEqualTypeOf<boolean>();
expectTypeOf<Snapshot<(typeof arkNotes)['shape']>['tags']>().toEqualTypeOf<
  readonly ('urgent' | 'later')[]
>();

// ---- a value at the top of a doc needs a default ----

// @ts-expect-error — valibot: no default
doc('notes', { pinned: v.boolean() });
// @ts-expect-error — zod: no default
doc('notes', { pinned: z.boolean() });
// @ts-expect-error — arktype: no default
doc('notes', { pinned: type('boolean') });
// @ts-expect-error — a plain object at the top is at the top too
doc('notes', { meta: { pinned: v.boolean() } });
// Inside a list item or a record, a value has no default: the item is given whole.
doc('notes', { tags: list(v.string()), byUser: record({ seen: v.boolean() }) });

// ---- read-only values keep their types ----

const branded = doc('notes', {
  ownerId: v.optional(v.pipe(v.string(), v.brand('UserId')), ''),
  roomId: z
    .string()
    .brand<'RoomId'>()
    .default('' as never),
  watchers: v.optional(v.set(v.string()), new Set<string>()),
  scores: v.optional(v.map(v.string(), v.number()), new Map<string, number>()),
  taskIds: v.optional(v.pipe(v.array(v.string()), v.brand('TaskIds')), [] as never),
});
type Branded = Snapshot<(typeof branded)['shape']>;
declare const brandedState: Branded;
// A branded ID is still a string.
const _ownerId: string = brandedState.ownerId;
const _roomId: string = brandedState.roomId;
void [_ownerId, _roomId];

// An unknown value stays unknown, and a recursive JSON type still compiles.
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
// (valibot's own `v.optional` around a recursive `v.custom` is too deep for TypeScript,
// so the JSON value here uses zod, and valibot inside a list.)
const loose = doc('notes', {
  extra: v.optional(v.unknown(), null),
  data: z.custom<Json>().default(null),
  items: list(v.custom<Json>(() => true)),
});
type Loose = Snapshot<(typeof loose)['shape']>;
expectTypeOf<Loose['extra']>().toBeUnknown();
const _data: Loose['data'] = { tags: ['urgent', { deep: [1, 2, { deeper: null }] }] };
const _items: Loose['items'] = [{ a: [1, { b: null }] }, 'note'];
void [_data, _items];

declare const brandedDraft: Draft<(typeof branded)['shape']>;
function editBranded() {
  // @ts-expect-error — a value's Set is read-only: set the whole value again
  brandedDraft.watchers.add('u_kofi');
  // @ts-expect-error — so is a value's Map
  brandedDraft.scores.set('u_kofi', 1);
  brandedDraft.watchers = new Set(['u_kofi']);
  // @ts-expect-error — a branded array is read-only too
  brandedDraft.taskIds.push('t_1042');
}

void editBranded;
