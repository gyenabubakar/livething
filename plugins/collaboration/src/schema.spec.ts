import { LiveThingConfigError } from '@livething/core';
import { doc, list, record, richText, text } from '~/schema.ts';
import { checkAwareness } from '~/server/awareness.ts';
import { type } from 'arktype';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

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

describe('doc()', () => {
  it('keeps the name, the shape and the awareness schema', () => {
    expect(taskBoard.name).toBe('task-board');
    expect(Object.keys(taskBoard.shape)).toEqual([
      'title',
      'archived',
      'columns',
      'tasks',
      'settings',
    ]);
    expect(taskBoard.awareness).toBeDefined();
    expect(doc('notes', { body: text() }).awareness).toBeUndefined();
  });

  it.each(['', 'Task-Board', 'task board', 'task/board', 'task:board', '-board', 'a'.repeat(65)])(
    'refuses the doc name %j',
    (name) => {
      expect(() => doc(name, { title: text() })).toThrow(LiveThingConfigError);
      expect(() => doc(name, { title: text() })).toThrow(/doc name/);
    },
  );

  it.each(['', 'a/b', 'a#b', '~a', 'a b', '__proto__', 'constructor'])(
    'refuses the field name %j',
    (key) => {
      expect(() => doc('notes', { [key]: text() })).toThrow(/field name/);
    },
  );

  it('refuses a field name inside a list item too, and says where', () => {
    expect(() => doc('notes', { items: list({ 'a/b': text() }) })).toThrow(/items\[\]\.a\/b/);
  });

  it.each([
    ['valibot', v.boolean()],
    ['zod', z.boolean()],
    ['arktype', type('boolean')],
  ])('refuses a %s value at the top with no default', (_, schema) => {
    expect(() => doc('notes', { pinned: schema } as never)).toThrow(LiveThingConfigError);
    expect(() => doc('notes', { pinned: schema } as never)).toThrow(/'pinned' needs a default/);
  });

  it('refuses a value with no default inside a plain object at the top', () => {
    expect(() => doc('notes', { meta: { pinned: v.boolean() } } as never)).toThrow(
      /'meta\.pinned' needs a default/,
    );
  });

  it.each([
    ['valibot', v.optional(v.boolean(), false)],
    ['zod', z.boolean().default(false)],
    ['arktype', type('boolean | undefined').pipe((value) => value ?? false)],
  ])('takes a %s value at the top with a default', (_, schema) => {
    expect(doc('notes', { pinned: schema }).shape.pinned).toBe(schema);
  });

  it('does not need defaults inside list items and records', () => {
    expect(() =>
      doc('notes', { tags: list(v.string()), byUser: record({ seen: v.boolean() }) }),
    ).not.toThrow();
  });

  it('refuses a value whose schema checks asynchronously', () => {
    const later = v.pipeAsync(
      v.optional(v.string(), ''),
      v.checkAsync(async () => true),
    );
    expect(() => doc('notes', { title: later } as never)).toThrow(/checks asynchronously/);
  });

  it.each([
    ['a string', 'text'],
    ['an array', [text()]],
    ['null', null],
    ['a number', 1],
    ['an empty object', {}],
  ])('refuses a field that is %s', (_, field) => {
    expect(() => doc('notes', { body: field } as never)).toThrow(LiveThingConfigError);
  });

  it('refuses a value whose schema is broken, with a clear error', () => {
    const throws = {
      '~standard': {
        version: 1,
        vendor: 'huddle',
        validate() {
          throw new Error('boom');
        },
      },
    };

    expect(() => doc('notes', { pinned: throws } as never)).toThrow(LiveThingConfigError);
    expect(() => doc('notes', { pinned: throws } as never)).toThrow(/'pinned'.*boom/);
    expect(() => doc('notes', { odd: { '~standard': text() } } as never)).toThrow(
      LiveThingConfigError,
    );
  });

  it('refuses a doc with no fields', () => {
    expect(() => doc('notes', {})).toThrow(/no fields/);
  });

  it('refuses an awareness option that is not a Standard Schema', () => {
    expect(() => doc('notes', { body: text() }, { awareness: {} as never })).toThrow(
      /awareness.*Standard Schema/,
    );
  });

  it('treats a schema that gives a thenable, not a Promise, as asynchronous too', () => {
    const thenable = {
      '~standard': {
        version: 1 as const,
        vendor: 'test',
        validate: () => ({ then: (resolve: (r: unknown) => void) => resolve({ issues: [] }) }),
      },
    } as never;
    const notes = doc('notes', { body: text() }, { awareness: thenable });
    const state = { user: { viewingTaskId: 'x' }, yjs: 1, editor: null, locks: [] };

    expect(() =>
      checkAwareness({ def: notes, canEdit: true, state, previous: null, others: [] }),
    ).toThrow(/checked asynchronously/);
    expect(() => doc('notes', { body: text(), done: thenable })).toThrow(/asynchronously/);
  });

  it('says clearly, on the server, that an awareness schema checked asynchronously', () => {
    const notes = doc(
      'notes',
      { body: text() },
      { awareness: v.objectAsync({ viewingTaskId: v.nullable(v.string()) }) },
    );
    const state = { user: { viewingTaskId: null }, yjs: 1, editor: null, locks: [] };

    expect(() =>
      checkAwareness({ def: notes, canEdit: true, state, previous: null, others: [] }),
    ).toThrow(/'notes' checked asynchronously/);
  });

  it('refuses a list or record item that is not a field', () => {
    expect(() => doc('notes', { tags: list('tag' as never) })).toThrow(/tags\[\]/);
    expect(() => doc('notes', { byUser: record(undefined as never) })).toThrow(/byUser\{\}/);
  });

  it('checks only values at the top with undefined, so other schemas may throw on it', () => {
    // zod turns a throw into a Promise, which would look like an async schema. A schema that
    // checks asynchronously is refused when a change is checked.
    const length = z
      .string()
      .optional()
      .transform((value) => value!.length);
    const watching = z.any().transform((state: { taskId: string }) => state.taskId);

    expect(() => doc('notes', { sizes: list(length) }, { awareness: watching })).not.toThrow();
  });

  it('says a value at the top that gives no value at once may check asynchronously or throw', () => {
    const throws = z
      .string()
      .optional()
      .transform((value) => value!.length);
    expect(() => doc('notes', { size: throws } as never)).toThrow(
      /'size' did not give its default at once: its schema checks asynchronously, or it throws/,
    );
  });

  it.each([undefined, null, 5])('refuses a doc name that is not a string: %j', (name) => {
    expect(() => doc(name as never, { body: text() })).toThrow(/doc name/);
  });

  it('takes a plain object with no prototype as a shape', () => {
    const meta = Object.assign(Object.create(null) as object, {
      pinned: v.optional(v.boolean(), false),
    });
    expect(() => doc('notes', { meta } as never)).not.toThrow();
  });

  it('refuses a shape that contains itself', () => {
    const loop: Record<string, unknown> = { body: text() };
    loop.again = loop;
    expect(() => doc('notes', loop as never)).toThrow(/'again' contains itself/);
  });
});
