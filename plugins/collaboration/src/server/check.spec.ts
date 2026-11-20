import { DocCore } from '~/doc/core.ts';
import { OUT_OF_ORDER } from '~/doc/wire.ts';
import { doc, list, text } from '~/schema.ts';
import { applyChecked } from '~/server/check.ts';
import { cycleUpdate, forwardUpdate } from '~/test/raw-update.ts';
import { open, seed, task, taskBoard } from '~/test/task-board.ts';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { z } from 'zod';

const FROM_CLIENT = { from: 'client' };

/** A server copy that took a seeded board, and a second client that follows it. */
function setup() {
  const server = new DocCore(taskBoard);
  const amara = seed();
  const kofi = new Y.Doc();
  const first = applyChecked(server, Y.encodeStateAsUpdate(amara.ydoc), FROM_CLIENT);
  expect(first.ok).toBe(true);

  Y.applyUpdate(kofi, Y.encodeStateAsUpdate(server.ydoc));

  return { server, amara, kofi };
}

/** The update an edit to amara's copy makes. */
function updateOf(ydoc: Y.Doc, edit: () => void): Uint8Array {
  const before = Y.encodeStateVector(ydoc);
  edit();
  return Y.encodeStateAsUpdate(ydoc, before);
}

function firstTask(ydoc: Y.Doc): Y.Map<unknown> {
  const items = ydoc.getMap('tasks#items');
  const id = ydoc.getArray<string>('tasks').get(0);
  return items.get(id) as Y.Map<unknown>;
}

describe('the server check', () => {
  it('lets a good update through, and gives it back to send to the others', () => {
    const { server, amara } = setup();
    const update = updateOf(amara.ydoc, () =>
      amara.change((d) => {
        d.tasks.at(0)!.done = true;
        d.tasks.move(0, 2);
        d.settings.set('u_amara', { collapsed: ['done'] });
      }),
    );

    expect(applyChecked(server, update, FROM_CLIENT)).toEqual({ ok: true, update });
    expect(server.read()).toEqual(amara.state.get());
  });

  it('lets typing in rich text from an editor through', () => {
    const { server, amara } = setup();
    const update = updateOf(amara.ydoc, () => {
      const notes = amara.yjs.at((p) => p.tasks[0]?.notes);
      const paragraph = new Y.XmlElement('paragraph');
      notes.insert(0, [paragraph]);
      paragraph.insert(0, [new Y.XmlText('Agenda')]);
      (paragraph.get(0) as Y.XmlText).format(0, 6, { bold: true });
    });

    expect(applyChecked(server, update, FROM_CLIENT).ok).toBe(true);
    expect(server.read().tasks[0]!.notes).toBe('Agenda');
  });

  it.each<[string, (ydoc: Y.Doc) => void]>([
    ['a string where a boolean goes', (ydoc) => firstTask(ydoc).set('done', 'yes')],
    ['an item of the wrong shape', (ydoc) => ydoc.getMap('tasks#items').set('x', 'not a task')],
    ['a deleted field of a task', (ydoc) => firstTask(ydoc).delete('assignee')],
    ['a number in a list order', (ydoc) => ydoc.getArray('tasks').push([42 as never])],
    ['a field a task does not have', (ydoc) => firstTask(ydoc).set('priority', 1)],
    ['a value that is not JSON', (ydoc) => ydoc.getMap('~').set('archived', new Y.Map())],
    ['a value the schema refuses at the top', (ydoc) => ydoc.getMap('~').set('archived', 'yes')],
    ['text replaced by a value', (ydoc) => firstTask(ydoc).set('title', 'plain string')],
    [
      'a map in rich text',
      (ydoc) => (firstTask(ydoc).get('notes') as Y.XmlFragment).insert(0, [new Y.Map() as never]),
    ],
    ['a record entry of the wrong shape', (ydoc) => ydoc.getMap('settings').set('u_amara', 7)],
  ])('undoes %s, and every copy ends up the same', (_, edit) => {
    const { server, amara, kofi } = setup();
    const before = server.read();
    const result = applyChecked(
      server,
      updateOf(amara.ydoc, () => edit(amara.ydoc)),
      FROM_CLIENT,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.reason).toEqual(expect.any(String));
    Y.applyUpdate(kofi, result.toOthers!);
    Y.applyUpdate(amara.ydoc, result.toSender!);
    expect(server.read()).toEqual(before);
    expect(new DocCore(taskBoard, kofi).read()).toEqual(before);

    expect(amara.state.get()).toEqual(before);
    expect(Y.encodeStateVector(kofi)).toEqual(Y.encodeStateVector(server.ydoc));
  });

  it.each<[string, unknown]>([
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a value nested too deep', JSON.parse(`${'['.repeat(300)}${']'.repeat(300)}`)],
    ['a Yjs type', new Y.Text('x')],
  ])('refuses %s in a value inside a list item', (_, value) => {
    const loose = doc('loose', { items: list({ data: v.any() }) });
    const server = new DocCore(loose);
    const client = open(loose);
    applyChecked(server, Y.encodeStateAsUpdate(client.ydoc), FROM_CLIENT);
    const first = updateOf(client.ydoc, () => client.change((d) => d.items.push({ data: 1 })));

    expect(applyChecked(server, first, FROM_CLIENT).ok).toBe(true);
    const item = client.ydoc
      .getMap('items#items')
      .get(client.ydoc.getArray<string>('items').get(0)!) as Y.Map<unknown>;
    const result = applyChecked(
      server,
      updateOf(client.ydoc, () => item.set('data', value)),
      FROM_CLIENT,
    );

    expect(result.ok === false && result.reason).toMatch(/JSON or bytes/);
  });

  it('refuses bytes that are not a Yjs update, and leaves the doc alone', () => {
    const { server } = setup();
    const before = Y.encodeStateVector(server.ydoc);

    expect(applyChecked(server, new Uint8Array([1, 2, 3, 250, 99, 7, 7, 7]), FROM_CLIENT)).toEqual({
      ok: false,
      reason: 'the bytes are not a Yjs update',
      toOthers: null,
      toSender: null,
    });
    expect(Y.encodeStateVector(server.ydoc)).toEqual(before);
  });

  it('refuses an update that needs updates the server has not seen', () => {
    const { server, amara } = setup();
    updateOf(amara.ydoc, () => amara.change((d) => void (d.title = 'Launch v2')));
    const later = updateOf(amara.ydoc, () => amara.change((d) => void (d.title = 'Launch v3')));
    const before = server.read();

    expect(applyChecked(server, later, FROM_CLIENT)).toEqual({
      ok: false,
      reason: 'the update needs earlier updates the server does not have',
      toOthers: null,
      toSender: null,
    });
    expect(server.read()).toEqual(before);
  });

  it('refuses an update that writes outside the doc, and undoes it so the sender stays in step', () => {
    const server = new DocCore(taskBoard);
    const client = new Y.Doc();
    client.getMap('junk').set('x', 'y'.repeat(1000));
    const result = applyChecked(server, Y.encodeStateAsUpdate(client), FROM_CLIENT);

    expect(result).toMatchObject({ ok: false, reason: "'junk' is not part of this doc" });
    const revert = result.ok ? null : result.toSender;
    expect(revert).not.toBeNull();
    Y.applyUpdate(client, revert!);

    expect(client.getMap('junk').size).toBe(0);
    expect(Y.encodeStateVector(client)).toEqual(Y.encodeStateVector(server.ydoc));
    // The junk is gone from what the server keeps, not only hidden.
    expect(Y.encodeStateAsUpdate(server.ydoc).length).toBeLessThan(200);

    const next = updateOf(client, () => client.getText('title').insert(0, 'Launch'));
    expect(applyChecked(server, next, FROM_CLIENT).ok).toBe(true);
    expect(server.read().title).toBe('Launch');
  });

  it.each([
    ['text', (ydoc: Y.Doc) => ydoc.getText('scratch').insert(0, 'x'.repeat(500))],
    ['map', (ydoc: Y.Doc) => ydoc.getMap('scratch').set('k', 'x'.repeat(500))],
    ['array', (ydoc: Y.Doc) => ydoc.getArray('scratch').insert(0, ['x'.repeat(500)])],
  ])('refuses every write outside the doc, not only the first (%s)', (_, write) => {
    const server = new DocCore(taskBoard);
    const client = new Y.Doc();

    for (let round = 0; round < 3; round += 1) {
      const result = applyChecked(
        server,
        updateOf(client, () => write(client)),
        FROM_CLIENT,
      );
      expect(result.ok).toBe(false);
      if (!result.ok && result.toSender) Y.applyUpdate(client, result.toSender);
    }

    expect(Y.encodeStateAsUpdate(server.ydoc).length).toBeLessThan(200);
  });

  const junk = 'x'.repeat(5000);

  it.each([
    ['text into the items map', (raw: Y.Doc) => raw.getText('tasks#items').insert(0, junk)],
    ['a list item into the items map', (raw: Y.Doc) => raw.getArray('tasks#items').push([junk])],
    ['text into a record map', (raw: Y.Doc) => raw.getText('settings').insert(0, junk)],
    ['a keyed value into a list order', (raw: Y.Doc) => raw.getMap('tasks').set('k', junk)],
    ['a keyed value into a text field', (raw: Y.Doc) => raw.getMap('title').set('k', junk)],
    ['a list item into a text field', (raw: Y.Doc) => raw.getArray('title').push([junk])],
    [
      'a huge format into a text field',
      (raw: Y.Doc) => raw.getText('title').insert(0, 'ab', { note: junk }),
    ],
  ])('refuses %s, and keeps none of it', (_, write) => {
    const { server } = setup();
    const before = server.read();
    const size = Y.encodeStateAsUpdate(server.ydoc).length;
    // A raw copy, where no root is typed yet, so any kind of content can be written anywhere.
    const raw = new Y.Doc();
    Y.applyUpdate(raw, Y.encodeStateAsUpdate(server.ydoc));

    const result = applyChecked(
      server,
      updateOf(raw, () => write(raw)),
      FROM_CLIENT,
    );

    expect(result.ok).toBe(false);
    expect(server.read()).toEqual(before);
    expect(Y.encodeStateAsUpdate(server.ydoc).length).toBeLessThan(size + 300);
  });

  it.each([
    [
      'a task added and deleted',
      (board: ReturnType<typeof seed>) => {
        board.change((d) => d.tasks.push(task('ta')));
        board.change((d) => d.tasks.delete(3, 1));
      },
    ],
    [
      'two tasks added and both deleted',
      (board: ReturnType<typeof seed>) => {
        board.change((d) => d.tasks.push(task('ta'), task('tb')));
        board.change((d) => d.tasks.delete(3, 2));
      },
    ],
    [
      'a task added, moved and deleted',
      (board: ReturnType<typeof seed>) => {
        board.change((d) => d.tasks.push(task('ta')));
        board.change((d) => d.tasks.move(3, 0));
        board.change((d) => d.tasks.delete(0, 1));
      },
    ],
  ])('takes what a client did offline, sent in one update: %s', (_, work) => {
    const { server, amara } = setup();
    const before = Y.encodeStateVector(amara.ydoc);

    work(amara);
    const result = applyChecked(server, Y.encodeStateAsUpdate(amara.ydoc, before), FROM_CLIENT);

    expect(result.ok).toBe(true);
    expect(server.read()).toEqual(amara.state.get());
  });

  it('takes every honest offline session, sent in one update', () => {
    let state = 7;
    function random(below: number): number {
      state = (state * 16807) % 2147483647;
      return state % below;
    }

    const edits = [
      (board: ReturnType<typeof seed>) =>
        board.change((d) => d.tasks.push(task(`t${random(1000)}`))),
      (board: ReturnType<typeof seed>) =>
        board.change((d) => {
          if (d.tasks.length > 0) d.tasks.delete(random(d.tasks.length), 1);
        }),
      (board: ReturnType<typeof seed>) =>
        board.change((d) => {
          if (d.tasks.length > 1) d.tasks.move(random(d.tasks.length), random(d.tasks.length));
        }),
      (board: ReturnType<typeof seed>) =>
        board.change((d) => {
          d.title = `Launch ${random(100)}`;
        }),
      (board: ReturnType<typeof seed>) =>
        board.change((d) => {
          const one = d.tasks.at(0);
          if (one) one.done = !one.done;
        }),
      (board: ReturnType<typeof seed>) =>
        board.change((d) => d.settings.set(`u${random(3)}`, { collapsed: ['done'] })),
      (board: ReturnType<typeof seed>) =>
        board.change((d) => {
          if (d.settings.has('u1')) d.settings.delete('u1');
        }),
      (board: ReturnType<typeof seed>) =>
        board.state.get().tasks.length > 0 &&
        board.change(() => {
          const notes = board.yjs.at((p) => p.tasks[0]?.notes);
          const paragraph = new Y.XmlElement('paragraph');
          notes.insert(0, [paragraph]);
          paragraph.insert(0, [new Y.XmlText(`Note ${random(10)}`)]);
        }),
      (board: ReturnType<typeof seed>) => board.history.undo(),
    ];

    for (let round = 0; round < 50; round += 1) {
      const { server, amara } = setup();
      const before = Y.encodeStateVector(amara.ydoc);
      for (let step = 0; step < 20; step += 1) edits[random(edits.length)]!(amara);

      const result = applyChecked(server, Y.encodeStateAsUpdate(amara.ydoc, before), FROM_CLIENT);

      expect(result).toMatchObject({ ok: true });
      expect(server.read()).toEqual(amara.state.get());
    }
  });

  it.each([
    ['an extra key', (checklist: Y.Map<unknown>) => checklist.set('junk', junk)],
    [
      'a value that is not an ID',
      (checklist: Y.Map<unknown>) =>
        (checklist.get('order') as Y.Array<unknown>).push([{ blob: junk }]),
    ],
  ])("refuses %s in a new item's nested list", (_, write) => {
    const board = doc('cards', {
      cards: list({ id: v.string(), checklist: list({ id: v.string(), label: text() }) }),
    });
    const server = new DocCore(board);
    const client = open(board);

    const update = updateOf(client.ydoc, () => {
      client.change((d) => d.cards.push({ id: 'c1', checklist: [] }));
      const card = client.ydoc
        .getMap('cards#items')
        .get(client.ydoc.getArray<string>('cards').get(0)!) as Y.Map<unknown>;
      write(card.get('checklist') as Y.Map<unknown>);
    });

    expect(applyChecked(server, update, FROM_CLIENT).ok).toBe(false);
    expect(Y.encodeStateAsUpdate(server.ydoc).length).toBeLessThan(500);
  });

  it.each([
    ['an item that points forward, so Yjs stops half way through', forwardUpdate(777, 'evil')],
    ['an item in a field, then one that points forward', forwardUpdate(777, 'title')],
    ['two clients whose items point at each other, so Yjs holds them forever', cycleUpdate()],
  ])('refuses %s, and keeps nothing of it', (_, update) => {
    const { server } = setup();
    const before = server.read();
    const memberBefore = Y.encodeStateAsUpdate(server.ydoc);

    const result = applyChecked(server, update, FROM_CLIENT);

    expect(result.ok).toBe(false);
    expect(server.ydoc.store.pendingStructs).toBeNull();
    expect(server.ydoc.store.pendingDs).toBeNull();
    expect(server.read()).toEqual(before);
    // Nothing of it reaches a member that syncs.
    const synced = new Y.Doc();
    Y.applyUpdate(synced, Y.encodeStateAsUpdate(server.ydoc));
    expect(synced.getText('evil').toString()).toBe('');

    // What the others get, and what is stored, applies cleanly and leaves them like the server.
    const member = new Y.Doc();
    Y.applyUpdate(member, memberBefore);
    if (!result.ok && result.toOthers) {
      expect(() => Y.applyUpdate(member, result.toOthers!)).not.toThrow();
    }

    expect(member.store.pendingStructs).toBeNull();
    expect(Y.encodeStateVector(member)).toEqual(Y.encodeStateVector(server.ydoc));
    expect(member.getText('evil').toString()).toBe('');
    expect(member.getText('title').toString()).toBe(server.ydoc.getText('title').toString());
  });

  it('refuses an update that points at items the server does not have, and keeps nothing of it', () => {
    const { server, amara } = setup();
    const before = server.read();
    const size = Y.encodeStateAsUpdate(server.ydoc).length;
    // `other` has edits the server never got; `bad` builds on them.
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(amara.ydoc));
    other.getText('title').insert(0, 'Unseen ');

    const bad = new Y.Doc();
    Y.applyUpdate(bad, Y.encodeStateAsUpdate(other));
    const update = updateOf(bad, () => {
      bad.getText('title').insert(1, 'Q');
      bad.getText('title').format(0, 3, { note: junk });
    });

    const result = applyChecked(server, update, FROM_CLIENT);

    expect(result).toEqual({ ok: false, reason: OUT_OF_ORDER, toOthers: null, toSender: null });
    expect(server.ydoc.store.pendingStructs).toBeNull();
    expect(server.read()).toEqual(before);
    expect(Y.encodeStateAsUpdate(server.ydoc).length).toBe(size);
  });

  it("keeps an attacker from hanging junk on another member's next edit", () => {
    const { server, amara } = setup();
    // A copy that has amara's next edit, so it can build on it before the server has it.
    const peek = new Y.Doc();
    Y.applyUpdate(peek, Y.encodeStateAsUpdate(amara.ydoc));
    const honest = updateOf(amara.ydoc, () => amara.ydoc.getText('title').insert(0, 'Honest '));
    Y.applyUpdate(peek, honest);
    const poison = updateOf(peek, () => peek.getText('title').insert(0, 'x'.repeat(5000)));

    expect(applyChecked(server, poison, FROM_CLIENT)).toMatchObject({
      ok: false,
      reason: OUT_OF_ORDER,
    });
    expect(applyChecked(server, honest, FROM_CLIENT).ok).toBe(true);
    expect(server.read().title).toBe('Honest Launch');
  });

  it.each([
    [
      'a new task with a field a task does not have',
      (raw: Y.Doc) => {
        const item = new Y.Map<unknown>();
        for (const [key, value] of Object.entries({
          id: 't9',
          column: 'todo',
          done: false,
          assignee: null,
        })) {
          item.set(key, value);
        }

        item.set('title', new Y.Text('Book a room'));
        item.set('notes', new Y.XmlFragment());
        item.set('junk', junk);
        raw.getMap('tasks#items').set('x.1', item);
        raw.getArray('tasks').push(['x.1']);
      },
    ],
    [
      'a new record entry with a field the entry does not have',
      (raw: Y.Doc) => {
        const entry = new Y.Map<unknown>();
        entry.set('collapsed', ['done']);
        entry.set('junk', junk);
        raw.getMap('settings').set('u_x', entry);
      },
    ],
    [
      'a huge attribute on a rich text element',
      (raw: Y.Doc) => {
        const notes = (
          raw.getMap('tasks#items').get(raw.getArray<string>('tasks').get(0)!) as Y.Map<unknown>
        ).get('notes') as Y.XmlFragment;
        const paragraph = new Y.XmlElement('paragraph');
        notes.insert(0, [paragraph]);
        paragraph.setAttribute('note', junk);
      },
    ],
    [
      'a huge format mark in rich text',
      (raw: Y.Doc) => {
        const notes = (
          raw.getMap('tasks#items').get(raw.getArray<string>('tasks').get(0)!) as Y.Map<unknown>
        ).get('notes') as Y.XmlFragment;
        const text = new Y.XmlText();
        notes.insert(0, [text]);
        text.insert(0, 'Agenda', { note: junk });
      },
    ],
  ])('refuses %s, and keeps none of it', (_, write) => {
    const { server } = setup();
    const before = server.read();
    const size = Y.encodeStateAsUpdate(server.ydoc).length;
    const raw = new Y.Doc();
    Y.applyUpdate(raw, Y.encodeStateAsUpdate(server.ydoc));

    const result = applyChecked(
      server,
      updateOf(raw, () => write(raw)),
      FROM_CLIENT,
    );

    expect(result.ok).toBe(false);
    expect(server.read()).toEqual(before);
    expect(Y.encodeStateAsUpdate(server.ydoc).length).toBeLessThan(size + 300);
  });

  it('takes rich text as an editor writes it: elements, small attributes and marks', () => {
    const { server, amara } = setup();

    const result = applyChecked(
      server,
      updateOf(amara.ydoc, () => {
        const notes = amara.yjs.at((p) => p.tasks[0]?.notes);
        const heading = new Y.XmlElement('heading');
        notes.insert(0, [heading]);
        heading.setAttribute('level', '2');

        const text = new Y.XmlText();
        heading.insert(0, [text]);
        text.insert(0, 'Agenda', { bold: true });
      }),
      FROM_CLIENT,
    );

    expect(result.ok).toBe(true);
  });

  it('takes small format marks in a text field, as a Quill binding writes them', () => {
    const { server, amara } = setup();

    const result = applyChecked(
      server,
      updateOf(amara.ydoc, () => amara.ydoc.getText('title').insert(0, 'Big', { bold: true })),
      FROM_CLIENT,
    );

    expect(result.ok).toBe(true);
    expect(server.read().title).toBe('BigLaunch');
  });

  it('refuses characters written into a list order', () => {
    const { server } = setup();
    const before = server.read();
    // A raw copy, where the order root is not typed yet, so it can be written as text.
    const raw = new Y.Doc();
    Y.applyUpdate(raw, Y.encodeStateAsUpdate(server.ydoc));

    const result = applyChecked(
      server,
      updateOf(raw, () => raw.getText('tasks').insert(0, 'zz')),
      FROM_CLIENT,
    );

    expect(result).toMatchObject({ ok: false, reason: 'a list order holds only item IDs' });
    expect(server.read()).toEqual(before);
    expect(server.ydoc.getArray('tasks').toJSON()).not.toContain('z');
  });

  it('checks a value by what was written, so a transform works', () => {
    const counter = doc('counter', {
      size: z
        .string()
        .default('')
        .transform((value) => value.length),
    });
    const server = new DocCore(counter);
    const client = open(counter);
    const update = updateOf(client.ydoc, () =>
      client.change((d) => void (d.size = 'four' as never)),
    );

    expect(applyChecked(server, update, FROM_CLIENT).ok).toBe(true);
    expect(server.read().size).toBe(4);
  });

  it('says where and why in the reason', () => {
    const { server, amara } = setup();
    const result = applyChecked(
      server,
      updateOf(amara.ydoc, () => firstTask(amara.ydoc).set('done', 'yes')),
      FROM_CLIENT,
    );

    expect(result.ok === false && result.reason).toMatch(/^done: /);
  });
});
