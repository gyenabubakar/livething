import 'fake-indexeddb/auto';

import { indexedDbStorage } from '~/client/indexeddb.ts';
import { collaboration } from '~/client/plugin.ts';
import { huddleClient, until } from '~/test/client.ts';
import { startServer } from '~/test/engine.ts';
import { memoryNetwork } from '~/test/network.ts';
import { task, taskBoard } from '~/test/task-board.ts';
import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import type { TextInput } from '~/client/bind-text.ts';
import type { CollaborationStorage, DocRef } from '~/doc/storage.ts';

/** A server with a seeded launch board, and a network to reach it. */
async function huddle() {
  const server = await startServer();
  await server
    .api()
    .doc('task-board', 'launch')
    .change((d) => {
      d.title = 'Launch';
      d.tasks.push(task('t1'), task('t2'));
    });

  return { ...server, network: memoryNetwork(server.engine) };
}

/** Storage in memory, as a device keeps it across reloads. */
function deviceStorage(): CollaborationStorage {
  const docs = new Map<string, Uint8Array[]>();
  function key(doc: DocRef) {
    return `${doc.type}:${doc.id}`;
  }

  return {
    load: (doc) => [...(docs.get(key(doc)) ?? [])],
    append(doc, update) {
      docs.set(key(doc), [...(docs.get(key(doc)) ?? []), update]);
    },
    compact(doc, state) {
      docs.set(key(doc), [state]);
    },
  };
}

/** A text input as a browser gives it, enough for `bindText`. */
function fakeInput() {
  let listener: (() => void) | null = null;
  const input = {
    value: '',
    selectionStart: 0 as number | null,
    selectionEnd: 0 as number | null,
    setSelectionRange(start: number, end: number) {
      input.selectionStart = start;
      input.selectionEnd = end;
    },
    addEventListener(_type: 'input', next: () => void) {
      listener = next;
    },
    removeEventListener() {
      listener = null;
    },
    type(value: string, cursor = value.length) {
      input.value = value;
      input.setSelectionRange(cursor, cursor);
      listener?.();
    },
  };

  return input satisfies TextInput;
}

describe('collaboration() on the client', () => {
  describe('opening', () => {
    it('opens a doc and syncs it, with access, status and content', async () => {
      const { network } = await huddle();
      const board = huddleClient(network, 'u_amara').collab.doc('task-board', 'launch');
      expect(board.status.get()).toBe('closed');

      const opening = board.open();
      expect(board.status.get()).toBe('opening');
      await opening;

      expect(board.status.get()).toBe('synced');
      expect(board.access.get()).toBe('edit');
      expect(board.state.get().tasks.map((t) => t.id)).toEqual(['t1', 't2']);
    });

    it('gives the same handle for the same doc', async () => {
      const { network } = await huddle();
      const { collab } = huddleClient(network, 'u_amara');

      expect(collab.doc('task-board', 'launch')).toBe(collab.doc('task-board', 'launch'));
      expect(collab.doc('task-board', 'launch')).not.toBe(collab.doc('task-board', 'roadmap'));
    });

    it('refuses a doc type it does not have and a bad doc ID', async () => {
      const { network } = await huddle();
      const { collab } = huddleClient(network, 'u_amara');

      expect(() => collab.doc('poll' as never, 'x')).toThrow("there is no doc type 'poll'");
      expect(() => collab.doc('task-board', '')).toThrow(/doc ID/);
    });

    it("shows 'opening', not 'offline', when a closed doc opens again", async () => {
      const { network } = await huddle();
      const board = huddleClient(network, 'u_amara').collab.doc('task-board', 'launch');
      await board.open();
      board.close();
      await until(() => board.status.get() === 'closed');

      const seen: string[] = [];
      board.status.subscribe((status) => seen.push(status));
      await board.open();

      expect(seen).toEqual(['opening', 'synced']);
    });

    it('counts open() and close(), and leaves after the last close and the delay', async () => {
      const { network, engine } = await huddle();
      const board = huddleClient(network, 'u_amara', { closeDelayMs: 30 }).collab.doc(
        'task-board',
        'launch',
      );
      const kofi = huddleClient(network, 'u_kofi').collab.doc('task-board', 'launch');
      await kofi.open();

      await board.open();
      await board.open();
      board.close();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(board.status.get()).toBe('synced');

      board.close();
      expect(board.status.get()).toBe('synced');
      await until(() => board.status.get() === 'closed');

      expect(board.access.get()).toBeNull();
      await until(() => kofi.awareness.others.get().size === 0);
      void engine;
    });

    it('rejects every waiting open() when access refuses, and counts no open', async () => {
      const { network } = await huddle();
      const board = huddleClient(network, 'u_out').collab.doc('task-board', 'launch');

      const results = await Promise.allSettled([board.open(), board.open()]);

      expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
      expect(board.status.get()).toBe('closed');
      await expect(board.open()).rejects.toBeDefined();
    });

    it('rejects open() when the doc is closed before it is synced', async () => {
      const { network } = await huddle();
      network.goOffline();
      const board = huddleClient(network, 'u_amara').collab.doc('task-board', 'launch');

      const opening = board.open();
      board.close();

      await expect(opening).rejects.toThrow(/closed/);
      expect(board.status.get()).toBe('closed');
      network.goOnline();
      await board.open();
      expect(board.status.get()).toBe('synced');
    });

    it('rejects open() without an unhandled rejection when closed during a slow device load', async () => {
      const { network } = await huddle();
      const device = deviceStorage();
      const storage: CollaborationStorage = {
        ...device,
        async load(doc) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          return device.load(doc);
        },
      };

      const board = huddleClient(network, 'u_amara', { storage }).collab.doc(
        'task-board',
        'launch',
      );
      const kofi = huddleClient(network, 'u_kofi').collab.doc('task-board', 'launch');
      await kofi.open();

      const opening = board.open();
      board.close();
      await new Promise((resolve) => setTimeout(resolve, 100));

      await expect(opening).rejects.toThrow(/closed/);
      // It did not join the room after all, and a new open() works.
      expect(kofi.awareness.others.get().size).toBe(0);
      await board.open();
      expect(board.status.get()).toBe('synced');
    });

    it('tries the device again on the next open() after a failed load', async () => {
      const { network } = await huddle();
      const device = deviceStorage();
      let fail = true;
      const storage: CollaborationStorage = {
        ...device,
        load(doc) {
          if (fail) throw new Error('disk busy');

          return device.load(doc);
        },
      };

      const board = huddleClient(network, 'u_amara', { storage }).collab.doc(
        'task-board',
        'launch',
      );

      await expect(board.open()).rejects.toThrow('disk busy');
      fail = false;
      await board.open();

      expect(board.status.get()).toBe('synced');
    });

    it('rejects open() when access refuses the client', async () => {
      const { network } = await huddle();
      const board = huddleClient(network, 'u_out').collab.doc('task-board', 'launch');

      await expect(board.open()).rejects.toMatchObject({
        code: expect.stringContaining('access-denied'),
      });
      expect(board.status.get()).toBe('closed');
    });
  });

  describe('editing', () => {
    it('sends changes both ways, and shows saving until the server acks', async () => {
      const { network, api } = await huddle();
      const amara = huddleClient(network, 'u_amara').collab.doc('task-board', 'launch');
      const kofi = huddleClient(network, 'u_kofi').collab.doc('task-board', 'launch');
      await amara.open();
      await kofi.open();

      const seen: string[] = [];
      amara.status.subscribe((status) => seen.push(status));

      amara.change((d) => {
        d.title = 'Launch plan';
      });
      kofi.change((d) => {
        d.tasks.push(task('t3'));
      });

      await until(() => kofi.state.get().title === 'Launch plan');
      await until(() => amara.state.get().tasks.length === 3);
      await until(() => amara.status.get() === 'synced');
      expect(seen).toEqual(['saving', 'synced']);
      expect((await api().doc('task-board', 'launch').read()).tasks.length).toBe(3);
    });

    it('keeps both edits when two members type in the same title at once', async () => {
      const { network } = await huddle();
      const amara = huddleClient(network, 'u_amara').collab.doc('task-board', 'launch');
      const kofi = huddleClient(network, 'u_kofi').collab.doc('task-board', 'launch');
      await amara.open();
      await kofi.open();

      amara.change((d) => {
        d.title = 'The Launch';
      });
      kofi.change((d) => {
        d.title = 'Launch!';
      });

      await until(() => amara.state.get().title === kofi.state.get().title);
      expect(amara.state.get().title).toBe('The Launch!');
    });

    it('moves a task for everyone', async () => {
      const { network } = await huddle();
      const amara = huddleClient(network, 'u_amara').collab.doc('task-board', 'launch');
      const kofi = huddleClient(network, 'u_kofi').collab.doc('task-board', 'launch');
      await amara.open();
      await kofi.open();

      amara.change((d) => d.tasks.move(0, 1));

      await until(() => kofi.state.get().tasks[0]?.id === 't2');
      expect(kofi.state.get().tasks.map((t) => t.id)).toEqual(['t2', 't1']);
    });

    it('sends an update over 256 KiB in parts', async () => {
      const { network, api } = await huddle();
      const amara = huddleClient(network, 'u_amara').collab.doc('task-board', 'launch');
      const kofi = huddleClient(network, 'u_kofi').collab.doc('task-board', 'launch');
      await amara.open();
      await kofi.open();

      const title = 'x'.repeat(700_000);

      amara.change((d) => {
        d.title = title;
      });

      await until(() => kofi.state.get().title === title);
      await until(() => amara.status.get() === 'synced');
      expect((await api().doc('task-board', 'launch').read()).title).toBe(title);
    });

    it('takes back a change the server refuses, and tells onRefused and onError', async () => {
      const { network } = await huddle();
      const errors: unknown[] = [];
      const amara = huddleClient(network, 'u_amara', {
        onError: (error) => errors.push(error),
      }).collab.doc('task-board', 'launch');
      await amara.open();

      const refusals: unknown[] = [];
      amara.onRefused((refusal) => refusals.push(refusal));

      // Past the schema, as an older app version or a bad client could write it.
      const ydoc = amara.yjs.doc;
      const first = ydoc.getMap('tasks#items').get(ydoc.getArray<string>('tasks').get(0)!);
      (first as Y.Map<unknown>).set('done', 'yes');

      await until(() => refusals.length === 1);
      expect(refusals).toEqual([{ reason: expect.stringMatching(/^done: /) }]);
      expect((first as Y.Map<unknown>).get('done')).toBe(false);
      await until(() => amara.status.get() === 'synced');
      // The state store could not read the bad content while it was there.
      expect(errors).toContainEqual(expect.objectContaining({ code: 'invalid-change' }));
    });

    it('stays in step after a raw write to a part the doc does not have', async () => {
      const { network, api } = await huddle();
      const amara = huddleClient(network, 'u_amara').collab.doc('task-board', 'launch');
      await amara.open();
      const refusals: string[] = [];
      amara.onRefused((refusal) => refusals.push(refusal.reason));

      amara.yjs.doc.getText('scratch').insert(0, 'x');
      amara.change((d) => {
        d.title = 'After';
      });

      await until(async () => (await api().doc('task-board', 'launch').read()).title === 'After');
      await until(() => refusals.length === 1);
      expect(refusals).toEqual(["'scratch' is not part of this doc"]);
      expect(amara.yjs.doc.getText('scratch').toString()).toBe('');
    });

    it('syncs again when the server refuses an update as out of order', async () => {
      const { network, api } = await huddle();
      const amara = huddleClient(network, 'u_amara').collab.doc('task-board', 'launch');
      await amara.open();
      const refusals: string[] = [];
      amara.onRefused((refusal) => refusals.push(refusal.reason));

      network.dropUpdates(1);
      amara.change((d) => {
        d.title = 'Launch plan';
      });
      amara.change((d) => {
        d.tasks.push(task('t3'));
      });

      await until(async () => {
        const stored = await api().doc('task-board', 'launch').read();
        return stored.title === 'Launch plan' && stored.tasks.length === 3;
      });
      await until(() => amara.status.get() === 'synced');

      // Nothing was undone: the resync saved it all, so onRefused stays quiet.
      expect(refusals).toEqual([]);
    });

    it('throws a read-only error for a change in a doc the client may only view', async () => {
      const { network } = await huddle();
      const guest = huddleClient(network, 'u_guest').collab.doc('task-board', 'launch');
      await guest.open();

      expect(guest.access.get()).toBe('view');
      expect(() =>
        guest.change((d) => {
          d.title = 'Hi';
        }),
      ).toThrow(
        expect.objectContaining({
          code: 'read-only',
          detail: { type: 'task-board', id: 'launch' },
        }),
      );
      expect(guest.state.get().title).toBe('Launch');
    });

    it('undoes only its own change, and the undo reaches the others', async () => {
      const { network } = await huddle();
      const amara = huddleClient(network, 'u_amara').collab.doc('task-board', 'launch');
      const kofi = huddleClient(network, 'u_kofi').collab.doc('task-board', 'launch');
      await amara.open();
      await kofi.open();

      amara.change((d) => {
        d.tasks.at(0)!.done = true;
      });
      kofi.change((d) => {
        d.tasks.at(1)!.title = 'Book the room';
      });
      await until(() => amara.state.get().tasks[1]?.title === 'Book the room');
      amara.history.undo();

      await until(() => kofi.state.get().tasks[0]?.done === false);
      expect(kofi.state.get().tasks[1]?.title).toBe('Book the room');
    });
  });

  describe('versions', () => {
    it('saves a version with the edits it just made, lists it, and reads it', async () => {
      const { network } = await huddle();
      const amara = huddleClient(network, 'u_amara').collab.doc('task-board', 'launch');
      await amara.open();

      amara.change((d) => {
        d.title = 'Launch plan';
      });
      const saved = await amara.versions.save('Plan');
      amara.change((d) => {
        d.title = 'Something else';
      });

      expect(saved).toEqual({
        id: expect.any(String),
        label: 'Plan',
        createdAt: expect.any(Number),
        author: 'u_amara',
      });
      expect(await amara.versions.list()).toEqual([saved]);
      expect((await amara.versions.read(saved.id)).title).toBe('Launch plan');
    });

    it('restores a version as one change: it reaches the others, and undo takes it back', async () => {
      const { network } = await huddle();
      const amara = huddleClient(network, 'u_amara').collab.doc('task-board', 'launch');
      const kofi = huddleClient(network, 'u_kofi').collab.doc('task-board', 'launch');
      await amara.open();
      await kofi.open();

      const saved = await amara.versions.save('Before the review');

      kofi.change((d) => {
        d.title = 'Reviewed';
        d.tasks.delete(0, 1);
      });
      await until(() => amara.state.get().title === 'Reviewed');
      await amara.versions.restore(saved.id);

      expect(amara.state.get()).toMatchObject({
        title: 'Launch',
        tasks: [{ id: 't1' }, { id: 't2' }],
      });
      await until(() => kofi.state.get().title === 'Launch');
      expect(kofi.state.get().tasks.map((t) => t.id)).toEqual(['t1', 't2']);

      amara.history.undo();
      await until(() => kofi.state.get().title === 'Reviewed');
      expect(kofi.state.get().tasks.map((t) => t.id)).toEqual(['t2']);
    });

    it('reads a version bigger than 256 KiB, sent in parts', async () => {
      const { network, api } = await huddle();
      const launch = api().doc('task-board', 'launch');
      const title = 'x'.repeat(300 * 1024);
      await launch.change((d) => {
        d.title = title;
      });
      const saved = await launch.versions.save('Long title');

      const amara = huddleClient(network, 'u_amara').collab.doc('task-board', 'launch');
      await amara.open();

      expect((await amara.versions.read(saved.id)).title).toBe(title);
    });

    it('lets a viewer list and read versions, but not save or restore one', async () => {
      const { network, api } = await huddle();
      const saved = await api().doc('task-board', 'launch').versions.save('Kickoff');
      const guest = huddleClient(network, 'u_guest').collab.doc('task-board', 'launch');
      await guest.open();

      expect(await guest.versions.list()).toEqual([saved]);
      expect((await guest.versions.read(saved.id)).title).toBe('Launch');
      await expect(guest.versions.save('Mine')).rejects.toMatchObject({ code: 'access-denied' });
      await expect(guest.versions.restore(saved.id)).rejects.toMatchObject({ code: 'read-only' });
      await expect(guest.versions.delete(saved.id)).rejects.toMatchObject({
        code: 'access-denied',
      });
    });

    it('deletes a version', async () => {
      const { network, api } = await huddle();
      const launch = api().doc('task-board', 'launch');
      const draft = await launch.versions.save('Draft');
      const final = await launch.versions.save('Final');
      const amara = huddleClient(network, 'u_amara').collab.doc('task-board', 'launch');

      await amara.open();

      await amara.versions.delete(draft.id);

      expect(await amara.versions.list()).toEqual([final]);
    });

    it('rejects a version ID the doc does not have', async () => {
      const { network } = await huddle();
      const amara = huddleClient(network, 'u_amara').collab.doc('task-board', 'launch');
      await amara.open();

      await expect(amara.versions.read('v_none')).rejects.toMatchObject({
        code: 'version-not-found',
      });
      await expect(amara.versions.delete('v_none')).rejects.toMatchObject({
        code: 'version-not-found',
      });
    });
  });

  describe('offline', () => {
    it('keeps changes made offline and sends them when the network is back', async () => {
      const { network, api } = await huddle();
      const amara = huddleClient(network, 'u_amara').collab.doc('task-board', 'launch');
      const kofi = huddleClient(network, 'u_kofi').collab.doc('task-board', 'launch');
      await amara.open();
      await kofi.open();

      network.goOffline();
      await until(() => amara.status.get() === 'offline');
      amara.change((d) => {
        d.title = 'Launch (draft)';
      });
      kofi.change((d) => {
        d.tasks.push(task('t3'));
      });
      network.goOnline();

      await until(() => amara.status.get() === 'synced' && kofi.status.get() === 'synced');
      await until(() => kofi.state.get().title === 'Launch (draft)');
      await until(() => amara.state.get().tasks.length === 3);
      const stored = await api().doc('task-board', 'launch').read();
      expect(stored.title).toBe('Launch (draft)');

      expect(stored.tasks.length).toBe(3);
    });

    it('tells onRefused when it rejoins as a viewer with edits the server never got', async () => {
      let role: 'edit' | 'view' = 'edit';
      const server = await startServer({ access: () => role });
      const network = memoryNetwork(server.engine);
      const amara = huddleClient(network, 'u_amara').collab.doc('task-board', 'launch');
      const refusals: string[] = [];

      amara.onRefused((refusal) => refusals.push(refusal.reason));
      await amara.open();

      network.goOffline();
      await until(() => amara.status.get() === 'offline');
      amara.change((d) => {
        d.title = 'Written offline';
      });
      role = 'view';
      network.goOnline();

      await until(() => amara.access.get() === 'view' && amara.status.get() === 'synced');
      await until(() => refusals.length === 1);
      expect(refusals).toEqual(['this client may only view the doc']);
      expect((await server.api().doc('task-board', 'launch').read()).title).toBe('');
    });

    it('tells onRefused nothing when a viewer opens and rejoins a doc with deleted content', async () => {
      const { network, api } = await huddle();
      await api()
        .doc('task-board', 'launch')
        .change((d) => {
          d.title = 'Lau';
          d.tasks.delete(0);
        });
      const guest = huddleClient(network, 'u_guest').collab.doc('task-board', 'launch');
      const refusals: string[] = [];
      guest.onRefused((refusal) => refusals.push(refusal.reason));

      await guest.open();

      network.goOffline();
      await until(() => guest.status.get() === 'offline');
      network.goOnline();
      await until(() => guest.status.get() === 'synced');

      expect(guest.state.get().title).toBe('Lau');
      expect(refusals).toEqual([]);
    });

    it('keeps an offline edit on the device across a reload, and syncs it later', async () => {
      const { network, api } = await huddle();
      const storage = deviceStorage();
      const before = huddleClient(network, 'u_amara', { storage }).collab.doc(
        'task-board',
        'launch',
      );
      await before.open();

      network.goOffline();
      before.change((d) => {
        d.title = 'Written offline';
      });
      await new Promise((resolve) => setTimeout(resolve, 10));

      const after = huddleClient(network, 'u_amara', { storage }).collab.doc(
        'task-board',
        'launch',
      );
      const opening = after.open();
      await until(() => after.state.get().title === 'Written offline');
      network.goOnline();
      await opening;

      await until(() => after.status.get() === 'synced');
      expect((await api().doc('task-board', 'launch').read()).title).toBe('Written offline');
    });

    it('tells onRefused when a viewer loads edits from the device that the server never got', async () => {
      let role: 'edit' | 'view' = 'edit';
      const server = await startServer({ access: () => role });
      const network = memoryNetwork(server.engine);
      const storage = deviceStorage();
      const before = huddleClient(network, 'u_amara', { storage }).collab.doc(
        'task-board',
        'launch',
      );

      await before.open();
      network.goOffline();
      before.change((d) => {
        d.title = 'Written offline';
      });
      await new Promise((resolve) => setTimeout(resolve, 10));

      role = 'view';
      network.goOnline();

      const after = huddleClient(network, 'u_amara', { storage }).collab.doc(
        'task-board',
        'launch',
      );
      const refusals: string[] = [];
      after.onRefused((refusal) => refusals.push(refusal.reason));
      await after.open();

      expect(after.access.get()).toBe('view');
      expect(refusals).toEqual(['this client may only view the doc']);
    });
  });

  describe('awareness and locks', () => {
    it('merges awareness updates, and shows them to the others', async () => {
      const { network } = await huddle();
      const amara = huddleClient(network, 'u_amara').collab.doc('task-board', 'launch');
      const kofi = huddleClient(network, 'u_kofi').collab.doc('task-board', 'launch');
      await amara.open();
      await kofi.open();

      amara.awareness.update({ viewingTaskId: 't1' });

      await until(
        () => [...kofi.awareness.others.get().values()][0]?.state?.viewingTaskId === 't1',
      );
      await until(() => amara.awareness.self.get()?.state?.viewingTaskId === 't1');
    });

    it('lets one member hold a lock, and frees it when that member closes the doc', async () => {
      const { network } = await huddle();
      const amara = huddleClient(network, 'u_amara').collab.doc('task-board', 'launch');
      const kofi = huddleClient(network, 'u_kofi').collab.doc('task-board', 'launch');
      await amara.open();
      await kofi.open();

      expect(await amara.lock('task:t1')).toBe(true);
      await until(() => kofi.locks.get().has('task:t1'));
      expect(await kofi.lock('task:t1')).toBe(false);
      expect(await amara.lock('task:t1')).toBe(true);

      amara.close();
      await until(() => !kofi.locks.get().has('task:t1'));
      expect(await kofi.lock('task:t1')).toBe(true);
    });

    it('frees a lock on unlock()', async () => {
      const { network } = await huddle();
      const amara = huddleClient(network, 'u_amara').collab.doc('task-board', 'launch');
      const kofi = huddleClient(network, 'u_kofi').collab.doc('task-board', 'launch');
      await amara.open();
      await kofi.open();

      await amara.lock('task:t1');

      amara.unlock('task:t1');

      await until(() => !kofi.locks.get().has('task:t1'));
      expect(await kofi.lock('task:t1')).toBe(true);
    });

    it('drops its locks on a disconnect, so it stays visible after a reconnect', async () => {
      const { engine } = await huddle();
      const amaraNetwork = memoryNetwork(engine);
      const amara = huddleClient(amaraNetwork, 'u_amara').collab.doc('task-board', 'launch');
      const kofi = huddleClient(memoryNetwork(engine), 'u_kofi').collab.doc('task-board', 'launch');
      await amara.open();

      await kofi.open();
      expect(await amara.lock('task:t1')).toBe(true);

      amaraNetwork.goOffline();
      await until(() => !kofi.locks.get().has('task:t1'));
      expect(await kofi.lock('task:t1')).toBe(true);
      amaraNetwork.goOnline();
      await until(() => amara.status.get() === 'synced');

      amara.awareness.update({ viewingTaskId: 't9' });
      await until(() =>
        [...kofi.awareness.others.get().values()].some((m) => m.state?.viewingTaskId === 't9'),
      );
      expect(kofi.locks.get().get('task:t1')?.meta).toMatchObject({});
      expect(amara.locks.get().get('task:t1')?.connectionId).not.toBe(
        amara.awareness.self.get()?.connectionId,
      );
    });

    it('resolves lock() false at once while the socket is down, not after the reconnect', async () => {
      const { network } = await huddle();
      const amara = huddleClient(network, 'u_amara').collab.doc('task-board', 'launch');
      await amara.open();

      network.goOffline();
      await until(() => amara.status.get() === 'offline');
      const later = new Promise((resolve) => setTimeout(() => resolve('still waiting'), 30));

      expect(await Promise.race([amara.lock('task:t1'), later])).toBe(false);
    });

    it('frees a lock unlocked right after lock(), before the server answered', async () => {
      const { network } = await huddle();
      const amara = huddleClient(network, 'u_amara').collab.doc('task-board', 'launch');
      const kofi = huddleClient(network, 'u_kofi').collab.doc('task-board', 'launch');
      await amara.open();
      await kofi.open();

      const locking = amara.lock('task:t1');
      amara.unlock('task:t1');
      await locking;

      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await kofi.lock('task:t1')).toBe(true);
    });

    it("refuses a lock to a 'view' client", async () => {
      const { network } = await huddle();
      const guest = huddleClient(network, 'u_guest').collab.doc('task-board', 'launch');
      await guest.open();

      expect(await guest.lock('task:t1')).toBe(false);
    });

    it('keeps a y-protocols Awareness in step with LiveThing awareness, both ways', async () => {
      const { network } = await huddle();
      const amara = huddleClient(network, 'u_amara').collab.doc('task-board', 'launch');
      const kofi = huddleClient(network, 'u_kofi').collab.doc('task-board', 'launch');
      await amara.open();
      await kofi.open();

      const changes: unknown[] = [];
      kofi.yjs.awareness.on('change', (change: unknown) => changes.push(change));

      amara.yjs.awareness.setLocalStateField('cursor', { anchor: 1, head: 4 });
      amara.yjs.awareness.setLocalStateField('user', { name: 'Amara', color: '#c33' });

      const amaraId = amara.yjs.doc.clientID;
      await until(() => kofi.yjs.awareness.getStates().get(amaraId)?.user?.name === 'Amara');
      expect(kofi.yjs.awareness.getStates().get(amaraId)).toEqual({
        cursor: { anchor: 1, head: 4 },
        user: { name: 'Amara', color: '#c33' },
      });
      expect(changes.length).toBeGreaterThan(0);

      amara.close();
      await until(() => !kofi.yjs.awareness.getStates().has(amaraId));
    });

    it("sends a y-protocols change only when a member's editor state changes", async () => {
      const { network } = await huddle();
      const amara = huddleClient(network, 'u_amara').collab.doc('task-board', 'launch');
      const kofi = huddleClient(network, 'u_kofi').collab.doc('task-board', 'launch');
      await amara.open();
      await kofi.open();

      kofi.yjs.awareness.setLocalStateField('cursor', { anchor: 1, head: 1 });
      await until(() => amara.yjs.awareness.getStates().has(kofi.yjs.doc.clientID));
      const changes: unknown[] = [];
      amara.yjs.awareness.on('change', (change: unknown) => changes.push(change));

      kofi.awareness.update({ viewingTaskId: 't1' });
      await until(
        () => [...amara.awareness.others.get().values()][0]?.state?.viewingTaskId === 't1',
      );

      expect(changes).toEqual([]);
    });

    it('does not drop a still member after the y-protocols 30 second timeout', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
      try {
        const awareness = (await import('y-protocols/awareness')).Awareness;
        const check = new awareness(new Y.Doc());
        const { network } = await huddle();
        const amara = huddleClient(network, 'u_amara').collab.doc('task-board', 'launch');
        const kofi = huddleClient(network, 'u_kofi').collab.doc('task-board', 'launch');

        await amara.open();
        await kofi.open();
        amara.yjs.awareness.setLocalStateField('cursor', { anchor: 1, head: 1 });
        const amaraId = amara.yjs.doc.clientID;
        await until(() => kofi.yjs.awareness.getStates().has(amaraId));

        vi.advanceTimersByTime(60_000);

        expect(kofi.yjs.awareness.getStates().has(amaraId)).toBe(true);
        check.destroy();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('bindText', () => {
    it('sends typing as changes, and keeps the cursor on its character when someone edits', async () => {
      const { network } = await huddle();
      const amara = huddleClient(network, 'u_amara').collab.doc('task-board', 'launch');
      const kofi = huddleClient(network, 'u_kofi').collab.doc('task-board', 'launch');
      await amara.open();
      await kofi.open();

      const input = fakeInput();
      const unbind = amara.bindText(input, (p) => p.title);
      expect(input.value).toBe('Launch');

      input.type('Launch plan', 6);
      await until(() => kofi.state.get().title === 'Launch plan');
      kofi.change((d) => {
        d.title = 'The Launch plan';
      });

      await until(() => input.value === 'The Launch plan');
      expect([input.selectionStart, input.selectionEnd]).toEqual([10, 10]);

      amara.history.undo();
      await until(() => input.value === 'The Launch');
      unbind();
      kofi.change((d) => {
        d.title = 'Other';
      });
      await until(() => amara.state.get().title === 'Other');

      expect(input.value).toBe('The Launch');
    });
  });

  describe('setup', () => {
    it('refuses a doc type listed twice, no doc types, and a bad closeDelayMs', () => {
      expect(() => collaboration({ docs: [taskBoard, taskBoard] })).toThrow(/listed twice/);
      expect(() => collaboration({ docs: [] })).toThrow(/at least one/);
      expect(() => collaboration({ docs: [taskBoard], closeDelayMs: 1.5 })).toThrow(/closeDelayMs/);
    });
  });
});

describe('indexedDbStorage()', () => {
  /** The update of one title edit on a fresh copy of the board. */
  function titleUpdate(title: string): Uint8Array {
    const ydoc = new Y.Doc();
    ydoc.getText('title').insert(0, title);
    return Y.encodeStateAsUpdate(ydoc);
  }

  /** The titles the stored updates give, in a fresh copy. */
  async function storedTitle(storage: CollaborationStorage, doc: DocRef): Promise<string> {
    const ydoc = new Y.Doc();
    for (const update of await storage.load(doc)) Y.applyUpdate(ydoc, update);

    return ydoc.getText('title').toString();
  }

  it('keeps updates in order by doc, and compacts them into one', async () => {
    const storage = indexedDbStorage({ name: `huddle-${Math.random()}` });
    const launch = { type: 'task-board', id: 'launch' };
    const roadmap = { type: 'task-board', id: 'roadmap' };
    const first = titleUpdate('Launch');
    const second = titleUpdate('Roadmap');

    await storage.append(launch, first);
    await storage.append(roadmap, second);
    expect(await storage.load(launch)).toEqual([first]);

    await storage.compact(launch, first);

    expect(await storage.load(launch)).toHaveLength(1);
    expect(await storedTitle(storage, launch)).toBe('Launch');
    expect(await storage.load(roadmap)).toEqual([second]);
  });

  it('keeps an update another tab stored when it compacts', async () => {
    const name = `huddle-${Math.random()}`;
    const thisTab = indexedDbStorage({ name });
    const otherTab = indexedDbStorage({ name });
    const launch = { type: 'task-board', id: 'launch' };

    const mine = titleUpdate('Mine ');
    const theirs = titleUpdate('Theirs ');

    await thisTab.append(launch, mine);
    await otherTab.append(launch, theirs);
    await thisTab.compact(launch, mine);

    const title = await storedTitle(otherTab, launch);
    expect(title).toContain('Mine');
    expect(title).toContain('Theirs');
  });

  it('keeps a board across a reload', async () => {
    const { network, api } = await huddle();
    const name = `huddle-${Math.random()}`;
    const first = huddleClient(network, 'u_amara', { storage: indexedDbStorage({ name }) });
    const before = first.collab.doc('task-board', 'launch');
    await before.open();

    network.goOffline();
    before.change((d) => {
      d.title = 'Kept on the device';
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const second = huddleClient(network, 'u_amara', { storage: indexedDbStorage({ name }) });
    const after = second.collab.doc('task-board', 'launch');
    const opening = after.open();
    await until(() => after.state.get().title === 'Kept on the device');
    network.goOnline();

    await opening;

    await until(
      async () => (await api().doc('task-board', 'launch').read()).title === 'Kept on the device',
    );
  });
});
