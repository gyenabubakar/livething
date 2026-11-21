import { LiveThingError } from '@livething/core';
import { createStore, derive } from '~/client/store.ts';
import { DocCore } from '~/doc/core.ts';
import { doc, list, record, richText, text } from '~/schema.ts';
import { ids, open, seed, task, taskBoard, twoOffline } from '~/test/task-board.ts';
import * as v from 'valibot';
import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { z } from 'zod';
import type { Draft } from '~/schema.ts';

describe('reading', () => {
  it('gives a new doc a full snapshot, with defaults', () => {
    expect(open(taskBoard).state.get()).toEqual({
      title: '',
      archived: false,
      columns: [],
      tasks: [],
      settings: {},
    });
  });

  it('keeps every part a change did not touch as the same object', () => {
    const board = seed();
    const before = board.state.get();
    board.change((d) => void (d.tasks.find((t) => t.id === 't1')!.done = true));
    const after = board.state.get();

    expect(after.tasks).not.toBe(before.tasks);
    expect(after.tasks[0]).not.toBe(before.tasks[0]);
    expect(after.tasks[1]).toBe(before.tasks[1]);
    expect(after.columns).toBe(before.columns);
    expect(after.settings).toBe(before.settings);
  });

  it('freezes the snapshot, values inside it too', () => {
    const board = seed();
    board.change((d) => d.settings.set('u_amara', { collapsed: ['done'] }));
    const state = board.state.get();

    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.tasks[0])).toBe(true);
    expect(Object.isFrozen(state.settings['u_amara']!.collapsed)).toBe(true);
  });

  it('reads a record key named __proto__ as a key, not as the prototype', () => {
    const board = seed();
    board.change((d) => {
      d.settings.set('__proto__', { collapsed: ['done'] });
      d.settings.set('u_amara', { collapsed: [] });
    });
    const { settings } = board.state.get();

    expect(Object.keys(settings)).toEqual(['__proto__', 'u_amara']);
    expect(Object.getPrototypeOf(settings)).toBe(Object.prototype);
  });

  it('stores a copy of a written value, so changing yours later changes nothing', () => {
    const board = seed();
    const collapsed = ['done'];
    board.change((d) => d.settings.set('u_amara', { collapsed }));
    board.state.get();
    collapsed.push('todo');

    const copy = open(taskBoard, new Y.Doc());
    Y.applyUpdate(copy.ydoc, Y.encodeStateAsUpdate(board.ydoc));

    expect(copy.state.get().settings['u_amara']!.collapsed).toEqual(['done']);
    expect(collapsed).toEqual(['done', 'todo']);
  });

  it('runs a select() that threw again on the next read, instead of giving undefined', () => {
    const board = seed();
    let fail = true;
    const title = board.select((s) => {
      if (fail) throw new Error('not ready');

      return s.title;
    });

    expect(() => title.get()).toThrow('not ready');
    fail = false;

    expect(title.get()).toBe('Launch');
  });

  it('keeps notifying an anchor watcher after an earlier one unsubscribed twice', () => {
    const board = seed();
    const anchor = board.anchor.text((p) => p.title, { from: 0, to: 6 });
    const place = board.anchor.watch(anchor);
    const stop = place.subscribe(() => {});
    stop();

    stop();

    const seen = vi.fn();
    place.subscribe(seen);
    board.change((d) => {
      d.title = `The ${d.title}`;
    });

    expect(seen).toHaveBeenCalledWith(expect.objectContaining({ from: 4, to: 10 }));
  });

  it('notifies once for one change()', () => {
    const board = seed();
    const listener = vi.fn();
    board.state.subscribe(listener);
    board.change((d) => {
      d.title = 'Launch v2';
      d.tasks.at(1)!.done = true;
      d.tasks.push(task('t4'));
    });

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('notifies select() only when its part changes', () => {
    const board = seed();
    const t2 = board.select((s) => s.tasks.find((t) => t.id === 't2'));
    const listener = vi.fn();
    t2.subscribe(listener);
    board.change((d) => void (d.tasks.at(0)!.done = true));

    expect(listener).not.toHaveBeenCalled();

    board.change((d) => void (d.tasks.at(1)!.done = true));

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('reads rich text as plain text, one line per block', () => {
    const board = seed();
    const notes = board.yjs.at((p) => p.tasks[0]?.notes);
    notes.insert(0, [new Y.XmlElement('paragraph'), new Y.XmlElement('paragraph')]);
    (notes.get(0) as Y.XmlElement).insert(0, [new Y.XmlText('Agenda')]);
    (notes.get(1) as Y.XmlElement).insert(0, [new Y.XmlText('Room 4')]);

    expect(board.state.get().tasks[0]!.notes).toBe('Agenda\nRoom 4');
  });

  it('gives each nested block its own line, as BlockNote and lists nest them', () => {
    const board = seed();
    const notes = board.yjs.at((p) => p.tasks[0]?.notes);
    const group = new Y.XmlElement('blockGroup');
    notes.insert(0, [group]);
    for (const line of ['Agenda', 'Room 4']) {
      const container = new Y.XmlElement('blockContainer');
      group.push([container]);
      const paragraph = new Y.XmlElement('paragraph');
      container.insert(0, [paragraph]);
      paragraph.insert(0, [new Y.XmlText(line)]);
    }

    expect(board.state.get().tasks[0]!.notes).toBe('Agenda\nRoom 4');
  });

  it('shows a value as its schema output, and stores what was written', () => {
    const counter = doc('counter', {
      size: z
        .string()
        .default('')
        .transform((value) => value.length),
    });
    const board = open(counter);
    board.change((d) => void (d.size = 'four' as never));

    expect(board.state.get().size).toBe(4);
    expect(board.ydoc.getMap('~').get('size')).toBe('four');
  });

  it('keeps the last good snapshot and reports content that breaks the schema', () => {
    const board = seed();
    const before = board.state.get();
    board.ydoc.getMap('~').set('archived', 'yes');

    expect(board.state.get()).toBe(before);
    expect(board.errors).toEqual([
      expect.objectContaining({
        code: 'invalid-change',
        detail: expect.objectContaining({ path: 'archived' }),
      }),
    ]);
  });
});

describe('writing', () => {
  it('merges an assigned text with someone else edit made at the same time', () => {
    const { amara, kofi, sync } = twoOffline();
    amara.change((d) => void (d.title = 'Our big Launch'));
    kofi.change((d) => void (d.title = 'Launch!'));
    sync();

    expect(amara.state.get().title).toBe('Our big Launch!');
    expect(kofi.state.get().title).toBe('Our big Launch!');
  });

  it('keeps both setups when two copies start a new doc offline', () => {
    const a = open(taskBoard);
    const b = open(taskBoard);
    a.change((d) => d.columns.push({ id: 'todo', name: 'To do' }));
    b.change((d) => d.columns.push({ id: 'done', name: 'Done' }));
    Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(a.ydoc));

    Y.applyUpdate(a.ydoc, Y.encodeStateAsUpdate(b.ydoc));

    expect(
      a.state
        .get()
        .columns.map((c) => c.id)
        .sort(),
    ).toEqual(['done', 'todo']);
  });

  it('returns what the change function returns', () => {
    const board = seed();
    expect(board.change((d) => d.tasks.length)).toBe(3);
  });

  it('refuses a value the schema refuses, and changes nothing', () => {
    const board = seed();
    const before = board.state.get();
    const listener = vi.fn();
    board.state.subscribe(listener);
    function bad() {
      board.change((d) => {
        d.title = 'half done';
        (d.tasks.at(0) as unknown as { done: unknown }).done = 'yes';
      });
    }

    expect(bad).toThrow(LiveThingError);
    expect(bad).toThrow(
      expect.objectContaining({
        code: 'invalid-change',
        detail: expect.objectContaining({ path: 'tasks[].done' }),
      }),
    );
    expect(board.state.get()).toBe(before);
    expect(listener).not.toHaveBeenCalled();
  });

  it('changes nothing when the change function throws', () => {
    const board = seed();
    const before = board.state.get();

    expect(() =>
      board.change((d) => {
        d.tasks.push(task('t4'));
        throw new Error('stop');
      }),
    ).toThrow('stop');
    expect(board.state.get()).toBe(before);
  });

  it('refuses an async change function, and a change() inside a change()', () => {
    const board = seed();
    const before = board.state.get();

    expect(() =>
      board.change(async (d) => {
        d.title = 'later';
      }),
    ).toThrow(/not async/);
    expect(() => board.change(() => board.change(() => {}))).toThrow(/inside another change/);
    expect(board.state.get()).toBe(before);
  });

  it('refuses bytes that are not a plain Uint8Array, such as a Node Buffer', () => {
    const anyValue = doc('loose', { extra: v.optional(v.any(), null) });
    const board = open(anyValue);

    expect(() => board.change((d) => void (d.extra = Buffer.from('hi')))).toThrow(
      expect.objectContaining({ code: 'invalid-change' }),
    );
    board.change((d) => void (d.extra = new Uint8Array([104, 105])));
    expect(board.state.get().extra).toEqual(new Uint8Array([104, 105]));
  });

  it('stores only the bytes of a Uint8Array view, not the whole buffer it views', () => {
    const anyValue = doc('loose', { extra: v.optional(v.any(), null) });
    const board = open(anyValue);
    const view = new Uint8Array(1_000_000).subarray(10, 20);

    board.change((d) => void (d.extra = view));

    const stored = board.state.get().extra as Uint8Array;
    expect(stored).toHaveLength(10);
    expect(stored.buffer.byteLength).toBe(10);
  });

  it('refuses an object with its own __proto__ key, which a peer would read differently', () => {
    const anyValue = doc('loose', { extra: v.optional(v.any(), null) });
    const board = open(anyValue);

    expect(() =>
      board.change((d) => void (d.extra = JSON.parse('{"__proto__":{"admin":true}}'))),
    ).toThrow(expect.objectContaining({ code: 'invalid-change' }));
  });

  it('refuses a string with half of an emoji, which UTF-8 would turn into another character', () => {
    const anyValue = doc('loose', { extra: v.optional(v.any(), null) });
    const board = open(anyValue);

    expect(() => board.change((d) => void (d.extra = 'ab\ud83d'))).toThrow(
      expect.objectContaining({ code: 'invalid-change' }),
    );
    expect(() => board.change((d) => void (d.extra = { ['\udc00']: 1 }))).toThrow(
      expect.objectContaining({ code: 'invalid-change' }),
    );
    board.change((d) => void (d.extra = 'ab😀'));
    expect(board.state.get().extra).toBe('ab😀');
  });

  it('refuses half of an emoji in text, rich text and record keys too', () => {
    const board = seed();
    const half = 'Launch \ud83d';
    const writes: ((d: Draft<typeof taskBoard.shape>) => void)[] = [
      (d) => void (d.title = half),
      (d) => void (d.tasks.at(0)!.title = half),
      (d) => d.tasks.push({ ...task('t9'), notes: half }),
      (d) => d.tasks.push({ ...task('t9'), title: half }),
      (d) => d.settings.set(half, { collapsed: [] }),
    ];

    for (const write of writes) {
      expect(() => board.change(write)).toThrow(
        expect.objectContaining({ code: 'invalid-change' }),
      );
    }

    expect(board.state.get().title).toBe('Launch');
  });

  it('refuses half of an emoji in a record key of a new item, and refuses writes to a deleted item', () => {
    const polls = doc('polls', {
      polls: list({
        id: v.string(),
        votes: record(v.number()),
        options: list(v.string()),
        meta: { closed: v.boolean() },
      }),
    });
    const board = open(polls);
    board.change((d) =>
      d.polls.push({ id: 'p1', votes: {}, options: [], meta: { closed: false } }),
    );
    const invalid = expect.objectContaining({ code: 'invalid-change' });

    expect(() =>
      board.change((d) =>
        d.polls.push({ id: 'p2', votes: { ['\ud83d']: 1 }, options: [], meta: { closed: false } }),
      ),
    ).toThrow(invalid);
    // Drafts taken before the delete: a write through them would be lost.
    expect(() =>
      board.change((d) => {
        const { votes } = d.polls.at(0)!;
        d.polls.delete(0);
        votes.set('u_amara', 1);
      }),
    ).toThrow(invalid);
    expect(() =>
      board.change((d) => {
        const { options } = d.polls.at(0)!;
        d.polls.delete(0);
        options.push('Pizza');
      }),
    ).toThrow(invalid);
    expect(() =>
      board.change((d) => {
        const poll = d.polls.at(0)!;
        d.polls.delete(0);
        return poll.meta.closed;
      }),
    ).toThrow(invalid);
    expect(() =>
      board.change((d) => {
        const poll = d.polls.at(0)!;
        d.polls.delete(0);
        poll.votes.set('u_amara', 1);
      }),
    ).toThrow(invalid);
    expect(() =>
      board.change((d) => {
        const poll = d.polls.at(0)!;
        d.polls.delete(0);
        poll.options.push('Pizza');
      }),
    ).toThrow(invalid);

    expect(board.state.get().polls).toHaveLength(1);
  });

  it('gives bytes in a snapshot as a copy, so writing to them does not change the doc', () => {
    const files = doc('files', { data: v.optional(v.instance(Uint8Array), new Uint8Array()) });
    const board = open(files);
    board.change((d) => void (d.data = new Uint8Array([1, 2, 3])));

    (board.state.get().data as Uint8Array)[0] = 99;

    const copy = open(files, new Y.Doc());
    Y.applyUpdate(copy.ydoc, Y.encodeStateAsUpdate(board.ydoc));
    expect([...(copy.state.get().data as Uint8Array)]).toEqual([1, 2, 3]);
    expect([...(board.ydoc.getMap('~').get('data') as Uint8Array)]).toEqual([1, 2, 3]);
  });

  it('runs select() again when its source changes from 0 to -0', () => {
    const source = createStore(0, () => {});
    const sign = derive(source.store, (n) => (Object.is(n, -0) ? 'negative' : 'positive'));
    expect(sign.get()).toBe('positive');

    source.set(-0);

    expect(sign.get()).toBe('negative');
  });

  it('gives every listener every value in order, when a listener sets the store again', () => {
    const count = createStore(0, () => {});
    const seen: [string, number][] = [];
    count.store.subscribe((n) => {
      seen.push(['first', n]);
      if (n !== 1) return;

      count.set(2);
      seen.push(['get', count.store.get()]);
    });
    count.store.subscribe((n) => seen.push(['second', n]));

    count.set(1);

    expect(seen).toEqual([
      ['first', 1],
      ['get', 2],
      ['second', 1],
      ['first', 2],
      ['second', 2],
    ]);
  });

  it('refuses a sparse array with invalid-change, in a value and in a new list', () => {
    const polls = doc('polls', {
      extra: v.optional(v.any(), null),
      polls: list({ id: v.string(), options: list(v.string()) }),
    });
    const board = open(polls);
    const invalid = expect.objectContaining({ code: 'invalid-change' });

    expect(() => board.change((d) => void (d.extra = new Array(2)))).toThrow(invalid);
    expect(() =>
      board.change((d) => d.polls.push({ id: 'p1', options: new Array(2) as string[] })),
    ).toThrow(invalid);
  });

  it('stores the value it checked, even when a getter would give another one later', () => {
    const anyValue = doc('loose', { extra: v.optional(v.object({ x: v.string() }), { x: '' }) });
    const board = open(anyValue);
    let reads = 0;
    const tricky = {
      get x() {
        reads += 1;
        return reads <= 2 ? 'ok' : 5;
      },
    };

    board.change((d) => void (d.extra = tricky as never));

    expect(board.state.get().extra).toEqual({ x: 'ok' });
  });

  it('refuses a schema whose output is not JSON or bytes, such as a Date', () => {
    const dated = doc('dated', {
      due: v.optional(
        v.pipe(
          v.string(),
          v.transform((text) => new Date(text)),
        ),
        '2026-01-01',
      ),
    });

    expect(() => open(dated).state.get()).toThrow();
  });

  it('refuses a value that is not JSON', () => {
    const anyValue = doc('loose', { extra: v.optional(v.any(), null) });
    const board = open(anyValue);

    expect(() => board.change((d) => void (d.extra = new Date()))).toThrow(
      expect.objectContaining({
        detail: expect.objectContaining({ reason: expect.stringMatching(/JSON/) }),
      }),
    );
  });

  it('refuses an async schema when a change is checked', () => {
    const later = doc('later', {
      tags: list(
        v.pipeAsync(
          v.string(),
          v.checkAsync(async () => true),
        ),
      ),
    });
    const board = open(later);

    expect(() => board.change((d) => d.tags.push('urgent'))).toThrow(
      expect.objectContaining({
        detail: expect.objectContaining({ reason: expect.stringMatching(/asynchronously/) }),
      }),
    );
  });

  it('refuses writes the draft does not allow', () => {
    const board = seed();
    expect(() =>
      board.change((d) => void ((d as unknown as { columns: unknown }).columns = [])),
    ).toThrow(/changed through its methods/);
    expect(() =>
      board.change((d) => void ((d.tasks.at(0) as unknown as { notes: string }).notes = 'x')),
    ).toThrow(/through an editor/);
    expect(() => board.change((d) => void ((d as unknown as { nope: number }).nope = 1))).toThrow(
      TypeError,
    );
    expect(() => board.change((d) => d.tasks.move(7, 0))).toThrow(/no item at index 7/);
  });

  it('edits nested lists, records of lists and deep paths', () => {
    const plan = doc('plan', {
      phases: list({ name: text(), steps: list({ title: text(), done: v.boolean() }) }),
      owners: record({ tasks: list(v.string()) }),
      meta: { summary: text(), tags: list(v.string()) },
    });
    const board = open(plan);
    board.change((d) => {
      d.phases.push({ name: 'Build', steps: [{ title: 'Schema', done: false }] });
      d.owners.set('u_amara', { tasks: ['t1'] });
      d.meta.summary = 'Ship it';
      d.meta.tags.push('urgent');
    });
    board.change((d) => {
      const steps = d.phases.at(0)!.steps;
      steps.push({ title: 'Engine', done: false });
      steps.at(0)!.done = true;
      steps.move(1, 0);
      d.owners.get('u_amara')!.tasks.push('t2');
    });

    expect(board.state.get()).toEqual({
      phases: [
        {
          name: 'Build',
          steps: [
            { title: 'Engine', done: false },
            { title: 'Schema', done: true },
          ],
        },
      ],
      owners: { u_amara: { tasks: ['t1', 't2'] } },
      meta: { summary: 'Ship it', tags: ['urgent'] },
    });
  });
});

describe('lists: real moves', () => {
  it('shows the problem: a copy-based move in plain Yjs duplicates an item two people move', () => {
    const a = new Y.Doc();
    a.getArray('tasks').insert(0, ['t1', 't2', 't3']);
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    a.getArray('tasks').delete(0, 1);

    a.getArray('tasks').insert(2, ['t1']);
    b.getArray('tasks').delete(0, 1);
    b.getArray('tasks').insert(1, ['t1']);
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));

    expect(
      a
        .getArray<string>('tasks')
        .toArray()
        .filter((id) => id === 't1'),
    ).toHaveLength(2);
  });

  it('shows a task two people move at once only once, the same everywhere', () => {
    const { amara, kofi, sync } = twoOffline();
    amara.change((d) => d.tasks.move(0, 2));
    kofi.change((d) => d.tasks.move(0, 1));
    sync();

    expect(ids(amara).filter((id) => id === 't1')).toHaveLength(1);
    expect(ids(amara)).toEqual(ids(kofi));
    expect(ids(amara)).toHaveLength(3);
  });

  it('keeps an edit to a task made while someone moves it', () => {
    const { amara, kofi, sync } = twoOffline();
    amara.change((d) => {
      d.tasks.move(0, 2);
      d.tasks.at(2)!.column = 'done';
    });
    kofi.change((d) => {
      const t1 = d.tasks.find((t) => t.id === 't1')!;
      t1.title = 'Write the launch notes';
      t1.assignee = 'u_kofi';
    });
    sync();

    expect(amara.state.get().tasks[2]).toMatchObject({
      id: 't1',
      column: 'done',
      title: 'Write the launch notes',
      assignee: 'u_kofi',
    });
  });

  it('keeps a task deleted when someone moves it at the same time', () => {
    const { amara, kofi, sync } = twoOffline();
    amara.change((d) => d.tasks.delete(0));
    kofi.change((d) => d.tasks.move(0, 2));
    sync();

    expect(ids(amara)).toEqual(['t2', 't3']);
    expect(ids(kofi)).toEqual(['t2', 't3']);
  });

  it('keeps each person run of new tasks together when two people add at one spot', () => {
    const { amara, kofi, sync } = twoOffline();
    amara.change((d) => d.tasks.insert(1, task('a1'), task('a2'), task('a3')));
    kofi.change((d) => d.tasks.insert(1, task('k1'), task('k2'), task('k3')));
    sync();
    const order = ids(amara).join(',');

    expect(order).toContain('a1,a2,a3');
    expect(order).toContain('k1,k2,k3');
    expect(ids(amara)).toEqual(ids(kofi));
  });

  it('gives a task the same keyOf before and after a move', () => {
    const board = seed();
    const key = board.keyOf(board.state.get().tasks[0]!);
    board.change((d) => d.tasks.move(0, 2));

    expect(key).toEqual(expect.any(String));
    expect(board.keyOf(board.state.get().tasks[2]!)).toBe(key);
  });
});

describe('history', () => {
  it('undoes only this copy changes, one change() at a time', () => {
    const { amara, kofi, sync } = twoOffline();
    amara.change((d) => void (d.tasks.at(0)!.done = true));
    amara.change((d) => void (d.tasks.at(2)!.done = true));
    kofi.change((d) => void (d.tasks.at(1)!.title = 'Book the big room'));
    sync();

    amara.history.undo();
    sync();

    expect(amara.state.get().tasks.map((t) => t.done)).toEqual([true, false, false]);
    expect(amara.state.get().tasks[1]!.title).toBe('Book the big room');
    expect(kofi.state.get().tasks[2]!.done).toBe(false);
    expect(amara.history.canRedo.get()).toBe(true);
  });

  it('puts a moved task back', () => {
    const board = seed();
    board.change((d) => d.tasks.move(0, 2));
    board.history.undo();

    expect(ids(board)).toEqual(['t1', 't2', 't3']);
  });

  it('leaves no undo step for a change that was rolled back', () => {
    const board = seed();
    board.change((d) => void (d.title = 'Launch v2'));
    expect(() =>
      board.change((d) => {
        d.tasks.push(task('t4'));
        throw new Error('stop');
      }),
    ).toThrow('stop');
    expect(() =>
      board.change(() => {
        throw new Error('stop before any write');
      }),
    ).toThrow();
    board.history.undo();

    expect(board.state.get().title).toBe('Launch');
    expect(ids(board)).toEqual(['t1', 't2', 't3']);
  });

  it('makes the changes between pause() and resume() one step', () => {
    const board = seed();
    board.history.pause();
    board.change((d) => d.tasks.move(0, 1));
    board.change((d) => d.tasks.move(1, 2));
    board.history.resume();

    board.change((d) => void (d.title = 'After the drag'));
    board.history.undo();

    expect(board.state.get().title).toBe('Launch');
    expect(ids(board)).toEqual(['t2', 't3', 't1']);

    board.history.undo();

    expect(ids(board)).toEqual(['t1', 't2', 't3']);
  });

  it('does not undo typing that came from somewhere else, such as an editor', () => {
    const board = seed();
    board.change((d) => void (d.title = 'Launch v2'));
    board.ydoc.transact(() => board.yjs.at((p) => p.title).insert(0, 'Big '), 'editor');
    board.history.undo();

    expect(board.state.get().title).toBe('Big Launch');
  });
});

describe('history around a failed change', () => {
  function failing(board: ReturnType<typeof seed>) {
    expect(() =>
      board.change((d) => {
        d.title = 'B';
        d.tasks.delete(0);
        d.tasks.set(0, { id: 'x' } as never);
      }),
    ).toThrow();
  }

  it('keeps the step before a pause apart when a paused change fails first', () => {
    const board = seed();
    board.history.pause();
    failing(board);
    board.change((d) => void (d.title = 'A'));
    board.history.resume();

    board.history.undo();

    expect(board.state.get().title).toBe('Launch');
    expect(ids(board)).toEqual(['t1', 't2', 't3']);
  });

  it('undoes a paused step cleanly when a change in the middle of it fails', () => {
    const board = seed();
    board.history.pause();
    board.change((d) => void (d.title = 'Launch A'));
    failing(board);
    board.change((d) => void (d.title = 'Launch AC'));

    board.history.resume();
    board.history.undo();

    expect(board.state.get().title).toBe('Launch');
    expect(ids(board)).toEqual(['t1', 't2', 't3']);
  });

  it('keeps the redo stack', () => {
    const board = seed();
    board.change((d) => void (d.title = 'A'));
    board.history.undo();
    failing(board);

    expect(board.history.canRedo.get()).toBe(true);

    board.history.redo();

    expect(board.state.get().title).toBe('A');
  });

  it('undoes text that a failed change replaced and a later change edits again', () => {
    const board = open(taskBoard);
    board.change((d) => void (d.title = 'two'));
    board.change((d) => void (d.title = 'p1'));
    expect(() =>
      board.change((d) => {
        d.title = 'bad';
        throw new Error('stop');
      }),
    ).toThrow('stop');
    board.change((d) => void (d.title = 'p2'));

    board.history.undo();
    expect(board.state.get().title).toBe('p1');
    board.history.undo();
    expect(board.state.get().title).toBe('two');
    board.history.undo();

    expect(board.state.get().title).toBe('');
  });

  it('refuses undo and redo inside a change()', () => {
    const board = seed();
    board.change((d) => void (d.title = 'A'));

    expect(() => board.change(() => board.history.undo())).toThrow(/inside a change\(\)/);
    expect(() => board.change(() => board.history.redo())).toThrow(/inside a change\(\)/);
    expect(board.state.get().title).toBe('A');
  });
});

describe('a draft after its change()', () => {
  it('refuses writes, after its change and inside a later one', () => {
    const board = seed();
    let kept: { title: string } | undefined;
    let tasks: { push(...items: unknown[]): void } | undefined;
    board.change((d) => {
      kept = d.tasks.at(0);
      tasks = d.tasks;
    });

    expect(() => void (kept!.title = 'sneaky')).toThrow(/inside its change\(\)/);
    expect(() => tasks!.push(task('t9'))).toThrow(/inside its change\(\)/);
    expect(() => board.change(() => tasks!.push(task('t9')))).toThrow(/inside its change\(\)/);
    expect(ids(board)).toEqual(['t1', 't2', 't3']);
    expect(board.state.get().tasks[0]!.title).toBe('Write notes');
  });

  it('refuses a write to an item the same change deleted, with invalid-change', () => {
    const board = seed();

    expect(() =>
      board.change((d) => {
        const first = d.tasks.at(0)!;
        d.tasks.delete(0);
        first.title = 'Lost';
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid-change' }));
    expect(ids(board)).toEqual(['t1', 't2', 't3']);
  });
});

describe('find() and findIndex() in a change', () => {
  it('see each item as it was when the change began, read before or not', () => {
    for (const readFirst of [false, true]) {
      // A bare DocCore, as the server has it: nothing has read it yet.
      const core = new DocCore(taskBoard);
      Y.applyUpdate(core.ydoc, Y.encodeStateAsUpdate(seed().ydoc));
      if (readFirst) core.read();

      const index = core.change((d) => {
        d.tasks.at(0)!.done = true;
        return d.tasks.findIndex((t) => t.done);
      });

      expect(index).toBe(-1);
    }
  });
});

describe('text inside a list or record', () => {
  it('gives yjs.at() and text anchors the text of an item', () => {
    const notes = doc('notes', { lines: list(text()), byUser: record(text()) });
    const board = open(notes);
    board.change((d) => {
      d.lines.push('hello world');
      d.byUser.set('u_amara', 'hi there');
    });

    expect(board.yjs.at((p) => p.lines[0])).toBeInstanceOf(Y.Text);
    expect(board.yjs.at((p) => p.byUser['u_amara'])).toBeInstanceOf(Y.Text);

    const anchor = board.anchor.text((p) => p.lines[0], { from: 6, to: 11 });

    expect(board.anchor.watch(anchor).get()).toEqual({ from: 6, to: 11, text: 'world' });
    expect(board.anchor.watch(board.anchor.item((p) => p.lines[0])).get()).toEqual({
      key: expect.any(String),
      index: 0,
    });
  });
});

describe('yjs.at()', () => {
  it('gives the Yjs type of a text or rich text field', () => {
    const board = seed();
    expect(board.yjs.at((p) => p.title)).toBeInstanceOf(Y.Text);
    expect(board.yjs.at((p) => p.tasks[0]?.notes)).toBeInstanceOf(Y.XmlFragment);
  });

  it('says why a path reaches no Yjs type', () => {
    const board = seed();
    expect(() => board.yjs.at((p) => p.tasks[9]?.title)).toThrow(/no item at index 9/);
    expect(() => board.yjs.at((p) => (p.tasks[0] as never as { done: never }).done)).toThrow(
      /plain value/,
    );
  });
});

describe('a doc made of every kind of field', () => {
  it('starts empty and reads every field', () => {
    const everything = doc('everything', {
      title: text(),
      body: richText(),
      count: v.optional(v.number(), 0),
      tags: list(v.string()),
      byUser: record(v.boolean()),
      meta: { note: text(), flag: v.optional(v.boolean(), true) },
    });

    expect(open(everything).state.get()).toEqual({
      title: '',
      body: '',
      count: 0,
      tags: [],
      byUser: {},
      meta: { note: '', flag: true },
    });
  });
});
