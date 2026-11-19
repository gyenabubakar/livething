import { DocCore } from '~/doc/core.ts';
import { doc, list } from '~/schema.ts';
import { applyChecked } from '~/server/check.ts';
import { open, seed, taskBoard } from '~/test/task-board.ts';
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

  it('refuses an update that writes outside the doc, without applying it', () => {
    const server = new DocCore(taskBoard);
    const evil = new Y.Doc();
    evil.getMap('junk').set('x', 'y'.repeat(1000));
    const result = applyChecked(server, Y.encodeStateAsUpdate(evil), FROM_CLIENT);

    expect(result).toEqual({
      ok: false,
      reason: "'junk' is not part of this doc",
      toOthers: null,
      toSender: null,
    });
    expect(server.ydoc.share.has('junk')).toBe(false);
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
