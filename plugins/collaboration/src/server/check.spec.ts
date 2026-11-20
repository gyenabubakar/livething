import { DocCore } from '~/doc/core.ts';
import { restoreFrom } from '~/doc/restore.ts';
import { OUT_OF_ORDER } from '~/doc/wire.ts';
import { doc, list, record, text } from '~/schema.ts';
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
      'a rich text attribute under 1024 characters but over 1024 bytes',
      (raw: Y.Doc) => {
        const notes = (
          raw.getMap('tasks#items').get(raw.getArray<string>('tasks').get(0)!) as Y.Map<unknown>
        ).get('notes') as Y.XmlFragment;
        const paragraph = new Y.XmlElement('paragraph');
        notes.insert(0, [paragraph]);
        paragraph.setAttribute('note', '日'.repeat(400));
      },
    ],
    [
      'a Yjs type as a rich text attribute',
      (raw: Y.Doc) => {
        const notes = (
          raw.getMap('tasks#items').get(raw.getArray<string>('tasks').get(0)!) as Y.Map<unknown>
        ).get('notes') as Y.XmlFragment;
        const paragraph = new Y.XmlElement('paragraph');
        notes.insert(0, [paragraph]);
        paragraph.setAttribute('note', new Y.Map() as unknown as string);
      },
    ],
    [
      'rich text nested more than 100 elements deep',
      (raw: Y.Doc) => {
        let parent: Y.XmlFragment | Y.XmlElement = (
          raw.getMap('tasks#items').get(raw.getArray<string>('tasks').get(0)!) as Y.Map<unknown>
        ).get('notes') as Y.XmlFragment;
        for (let depth = 0; depth < 101; depth += 1) {
          const next = new Y.XmlElement('blockGroup');
          parent.insert(0, [next]);
          parent = next;
        }
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

  it('keeps a field removed from the doc type unread, so undo and restore of old items work', () => {
    // Polls and settings stored while the doc type still had a `legacy` field.
    const before = open(
      doc('poll-board', {
        polls: list({ id: v.string(), legacy: v.optional(v.string(), 'x') }),
        settings: record({ legacy: v.optional(v.string(), 'x') }),
        legacyFlag: v.optional(v.boolean(), false),
      }),
    );
    before.change((d) => {
      d.polls.push({ id: 'p1', legacy: 'old' });
      d.settings.set('u_amara', { legacy: 'old' });
      d.legacyFlag = true;
    });
    const pollBoard = doc('poll-board', {
      polls: list({ id: v.string() }),
      settings: record({ theme: v.optional(v.string(), 'light') }),
    });
    const server = new DocCore(pollBoard);
    Y.applyUpdate(server.ydoc, Y.encodeStateAsUpdate(before.ydoc));

    const client = open(pollBoard);
    Y.applyUpdate(client.ydoc, Y.encodeStateAsUpdate(server.ydoc));
    function send(edit: () => void) {
      return applyChecked(server, updateOf(client.ydoc, edit), FROM_CLIENT);
    }

    expect(send(() => client.change((d) => d.polls.delete(0))).ok).toBe(true);
    expect(send(() => client.history.undo()).ok).toBe(true);
    expect(send(() => client.change((d) => d.settings.delete('u_amara'))).ok).toBe(true);
    expect(send(() => client.history.undo()).ok).toBe(true);

    // A version saved under the old doc type, restored over items made since.
    const version = new Y.Doc();
    Y.applyUpdate(version, Y.encodeStateAsUpdate(before.ydoc));
    expect(send(() => client.change((d) => d.polls.push({ id: 'p2' }))).ok).toBe(true);
    const poll = client.ydoc.getMap('polls#items').values().next().value as Y.Map<unknown>;
    expect(send(() => poll.delete('legacy')).ok).toBe(true);

    expect(send(() => client.ydoc.getMap('~').delete('legacyFlag')).ok).toBe(true);
    expect(send(() => client.change(() => restoreFrom(client.ydoc, version, pollBoard))).ok).toBe(
      true,
    );

    expect(server.read()).toEqual(client.state.get());
    expect(server.read().polls).toEqual([{ id: 'p1' }]);
  });

  it('refuses Yjs types nested past 200 deep before applying them, so the item can still go', () => {
    const { server, amara } = setup();
    const before = server.read();
    // Nested one level at a time: Yjs itself overflows when it nests a deep chain at once.
    function nest(levels: number, start: Y.Map<unknown>): Y.Map<unknown> {
      let parent = start;
      for (let level = 0; level < levels; level += 1) {
        const next = new Y.Map<unknown>();
        parent.set('junk', next);
        parent = next;
      }

      return parent;
    }

    const deep = applyChecked(
      server,
      updateOf(amara.ydoc, () => nest(2500, firstTask(amara.ydoc))),
      FROM_CLIENT,
    );

    expect(deep).toMatchObject({ ok: false, reason: expect.stringMatching(/nest at most 200/) });
    expect(server.read()).toEqual(before);
  });

  it('refuses a chain of Yjs types that grows past 200 deep over several updates', () => {
    const { server } = setup();
    const raw = new Y.Doc();
    Y.applyUpdate(raw, Y.encodeStateAsUpdate(server.ydoc));
    let tip = firstTask(raw);
    const results = [0, 1].map(() =>
      applyChecked(
        server,
        updateOf(raw, () => {
          for (let level = 0; level < 150; level += 1) {
            const next = new Y.Map<unknown>();
            tip.set('junk', next);
            tip = next;
          }
        }),
        FROM_CLIENT,
      ),
    );

    expect(results[0]!.ok).toBe(true);
    expect(results[1]).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/nest at most 200/),
    });
    const raw2 = new Y.Doc();
    Y.applyUpdate(raw2, Y.encodeStateAsUpdate(server.ydoc));
    expect(
      applyChecked(
        server,
        updateOf(raw2, () => raw2.getArray('tasks').delete(0, 1)),
        FROM_CLIENT,
      ).ok,
    ).toBe(true);
  });

  it('takes an undo that deletes a value with a default, and refuses deleting one without', () => {
    // A poll stored before `closed` was added to the doc type, so its map has no `closed`.
    const before = open(
      doc('poll-board', { polls: list({ id: v.string(), question: v.string() }) }),
    );
    before.change((d) => d.polls.push({ id: 'p1', question: 'Lunch?' }));
    const pollBoard = doc('poll-board', {
      polls: list({
        id: v.string(),
        question: v.string(),
        closed: v.optional(v.boolean(), false),
      }),
    });
    const server = new DocCore(pollBoard);
    Y.applyUpdate(server.ydoc, Y.encodeStateAsUpdate(before.ydoc));

    const client = open(pollBoard);
    Y.applyUpdate(client.ydoc, Y.encodeStateAsUpdate(server.ydoc));
    function send(edit: () => void) {
      return applyChecked(server, updateOf(client.ydoc, edit), FROM_CLIENT);
    }

    expect(send(() => client.change((d) => void (d.polls.at(0)!.closed = true))).ok).toBe(true);
    expect(send(() => client.history.undo()).ok).toBe(true);
    expect(server.read().polls[0]!.closed).toBe(false);

    const item = client.ydoc.getMap('polls#items').values().next().value as Y.Map<unknown>;
    expect(send(() => item.delete('question'))).toMatchObject({ ok: false });
  });

  it('takes rich text 100 elements deep, with text in the deepest one', () => {
    const { server, amara } = setup();

    const result = applyChecked(
      server,
      updateOf(amara.ydoc, () => {
        let parent: Y.XmlFragment = amara.yjs.at((p) => p.tasks[0]?.notes);
        for (let depth = 0; depth < 100; depth += 1) {
          const next = new Y.XmlElement('blockGroup');
          parent.insert(0, [next]);
          parent = next;
        }

        parent.insert(0, [new Y.XmlText('Deep')]);
      }),
      FROM_CLIENT,
    );

    expect(result.ok).toBe(true);
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
