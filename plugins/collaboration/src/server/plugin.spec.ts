import { decodeBase64, encodeBinaryFrame } from '@livething/core';
import { collaboration } from '~/server/plugin.ts';
import { sqlStorage } from '~/server/storage.ts';
import { connect, settle, startServer, testSql } from '~/test/engine.ts';
import { open, task, taskBoard } from '~/test/task-board.ts';
import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import type { Engine } from '@livething/server/adapters';
import type { VersionInfo } from '~/doc/wire.ts';
import type { ServerStorage } from '~/server/storage.ts';

/** A client with its own copy of the board, in sync with the server. */
async function member(engine: Engine, userId: string, id = 'launch') {
  const client = await connect(engine, userId);
  const board = open(taskBoard);
  await client.open(id);

  let seen = 0;
  let pieces: Uint8Array[] = [];
  /** Apply every update the server sent since the last call, putting parts back together. */
  function catchUp() {
    for (const frame of client.sent.slice(seen)) {
      if (frame.event !== 'update' || !frame.bytes) continue;

      const part = (frame.info as { part?: [number, number] } | null)?.part;
      pieces.push(frame.bytes);
      if (part && part[0] < part[1] - 1) continue;

      Y.applyUpdate(board.ydoc, Y.mergeUpdates([joinBytes(pieces)]), 'server');
      pieces = [];
    }

    seen = client.sent.length;
  }

  const reply = await client.sync(id, Y.encodeStateVector(board.ydoc));
  catchUp();

  /** Make an edit on this copy and send it as update `n`. */
  async function edit(n: number, mutate: (ydoc: Y.Doc) => void) {
    const before = Y.encodeStateVector(board.ydoc);
    mutate(board.ydoc);
    await client.update(id, { n }, Y.encodeStateAsUpdate(board.ydoc, before));
  }

  return { ...client, board, reply, catchUp, edit };
}

function joinBytes(pieces: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(pieces.reduce((size, piece) => size + piece.length, 0));
  let at = 0;
  for (const piece of pieces) {
    out.set(piece, at);
    at += piece.length;
  }

  return out;
}

function firstTask(ydoc: Y.Doc): Y.Map<unknown> {
  return ydoc.getMap('tasks#items').get(ydoc.getArray<string>('tasks').get(0)) as Y.Map<unknown>;
}

/** Storage in memory, over `docs` (the stored updates of each doc), that records what the plugin asks of it. */
function memoryStorage(docs = new Map<string, Uint8Array[]>()) {
  const calls: string[] = [];
  const versions = new Map<string, { info: VersionInfo; state: Uint8Array }>();
  const storage: ServerStorage = {
    saveVersion(_doc, info, state) {
      versions.set(info.id, { info, state });
    },
    listVersions: () => [...versions.values()].map((version) => version.info).reverse(),
    readVersion: (_doc, id) => versions.get(id)?.state ?? null,
    load(doc) {
      calls.push(`load ${doc.type}:${doc.id}`);
      return [...(docs.get(`${doc.type}:${doc.id}`) ?? [])];
    },
    append(doc, update) {
      calls.push('append');
      docs.set(`${doc.type}:${doc.id}`, [...(docs.get(`${doc.type}:${doc.id}`) ?? []), update]);
    },
    compact(doc, state) {
      calls.push('compact');
      docs.set(`${doc.type}:${doc.id}`, [state]);
    },
  };

  return { storage, docs, calls };
}

describe('collaboration() on the server', () => {
  describe('opening a doc', () => {
    it('syncs an empty client, with its access and the server vector', async () => {
      const { engine, api } = await startServer();
      await api()
        .doc('task-board', 'launch')
        .change((d) => {
          d.title = 'Launch';
        });

      const amara = await member(engine, 'u_amara');

      expect(amara.reply?.info).toEqual({ access: 'edit', vector: expect.any(String) });
      expect(amara.board.state.get().title).toBe('Launch');
      expect(decodeBase64((amara.reply!.info as { vector: string }).vector)).toEqual(
        Y.encodeStateVector(amara.board.ydoc),
      );
    });

    it("gives a 'view' client its access, and refuses a client access says false to", async () => {
      const { engine } = await startServer();

      const guest = await member(engine, 'u_guest');
      const outsider = await connect(engine, 'u_out');
      await outsider.open('launch');

      expect(guest.reply?.info).toMatchObject({ access: 'view' });
      expect(outsider.errors()).toEqual([
        expect.objectContaining({
          code: 'access-denied',
          detail: { type: 'task-board', id: 'launch' },
        }),
      ]);
    });

    it('refuses a sync from a client that did not open the doc', async () => {
      const { engine } = await startServer();
      const amara = await connect(engine, 'u_amara');

      await amara.sync('launch', Y.encodeStateVector(new Y.Doc()));

      expect(amara.errors().map((error) => error.code)).toEqual(['channel-not-subscribed']);
    });

    it('refuses sync bytes that are not a state vector', async () => {
      const { engine } = await startServer();
      const amara = await connect(engine, 'u_amara');
      await amara.open('launch');

      await amara.sync('launch', new Uint8Array([200, 200, 200]));

      expect(amara.errors()).toEqual([expect.objectContaining({ code: 'invalid-message' })]);
    });

    it('runs access again when the client opens the doc again, and takes the new answer', async () => {
      let answer: 'edit' | 'view' = 'edit';
      const { engine } = await startServer({ access: () => answer });
      const amara = await member(engine, 'u_amara');
      await amara.leave('launch');

      answer = 'view';
      await amara.open('launch');
      await amara.edit(1, (ydoc) => ydoc.getText('title').insert(0, 'Hi'));

      expect(amara.of('refused').at(-1)?.info).toEqual({
        n: 1,
        reason: 'this client may only view the doc',
      });
    });

    it('gives access the user, the meta, the connection and the doc', async () => {
      const access = vi.fn(() => 'edit' as const);
      const { engine } = await startServer({ access });

      const amara = await member(engine, 'u_amara', 'roadmap');

      expect(access).toHaveBeenCalledWith(
        { user: { id: 'u_amara' }, meta: {}, connection: { id: amara.id } },
        { type: 'task-board', id: 'roadmap' },
      );
    });
  });

  describe('updates', () => {
    it('sends a good update to every other member, and acks it to the sender', async () => {
      const { engine } = await startServer();
      const amara = await member(engine, 'u_amara');
      const kofi = await member(engine, 'u_kofi');

      await amara.edit(1, (ydoc) => ydoc.getText('title').insert(0, 'Launch'));
      kofi.catchUp();

      expect(amara.of('ack').map((frame) => frame.info)).toEqual([{ n: 1 }]);
      expect(kofi.board.state.get().title).toBe('Launch');
    });

    it('refuses a bad update, and the sender and the others end up without it', async () => {
      const { engine, api } = await startServer();
      await api()
        .doc('task-board', 'launch')
        .change((d) => {
          d.tasks.push(task('t1'));
        });
      const amara = await member(engine, 'u_amara');
      const kofi = await member(engine, 'u_kofi');

      await amara.edit(4, (ydoc) => firstTask(ydoc).set('done', 'yes'));
      const refused = amara.of('refused')[0]!;
      Y.applyUpdate(amara.board.ydoc, refused.bytes!, 'server');
      kofi.catchUp();

      expect(refused.info).toEqual({ n: 4, reason: expect.stringMatching(/^done: /) });
      expect(amara.board.state.get().tasks[0]?.done).toBe(false);
      expect(kofi.board.state.get().tasks[0]?.done).toBe(false);
      expect(kofi.errors()).toEqual([]);
      expect(Y.encodeStateVector(kofi.board.ydoc)).toEqual(Y.encodeStateVector(amara.board.ydoc));

      expect((await api().doc('task-board', 'launch').read()).tasks[0]?.done).toBe(false);
    });

    it("refuses every update from a 'view' client", async () => {
      const { engine, api } = await startServer();
      const guest = await member(engine, 'u_guest');

      await guest.edit(1, (ydoc) => ydoc.getText('title').insert(0, 'Hi'));

      expect(guest.of('refused').map((frame) => frame.info)).toEqual([
        { n: 1, reason: 'this client may only view the doc' },
      ]);
      expect((await api().doc('task-board', 'launch').read()).title).toBe('');
    });

    it('puts an update sent in parts back together', async () => {
      const { engine } = await startServer();
      const amara = await member(engine, 'u_amara');
      const kofi = await member(engine, 'u_kofi');
      const before = Y.encodeStateVector(amara.board.ydoc);
      amara.board.ydoc.getText('title').insert(0, 'A long title for the launch');

      const update = Y.encodeStateAsUpdate(amara.board.ydoc, before);
      const third = Math.ceil(update.length / 3);

      for (let index = 0; index < 3; index += 1) {
        await amara.update(
          'launch',
          { n: 1, part: [index, 3] },
          update.subarray(index * third, (index + 1) * third),
        );
      }

      kofi.catchUp();

      expect(amara.of('ack').map((frame) => frame.info)).toEqual([{ n: 1 }]);
      expect(kofi.board.state.get().title).toBe('A long title for the launch');
    });

    it('keeps the parts waiting for one room when the client leaves another', async () => {
      const { engine } = await startServer();
      const amara = await member(engine, 'u_amara', 'launch2');
      await amara.open('launch');

      const before = Y.encodeStateVector(amara.board.ydoc);
      amara.board.ydoc.getText('title').insert(0, 'Plan');
      const update = Y.encodeStateAsUpdate(amara.board.ydoc, before);

      await amara.update('launch2', { n: 1, part: [0, 2] }, update.subarray(0, 4));
      await amara.leave('launch');
      await amara.update('launch2', { n: 1, part: [1, 2] }, update.subarray(4));

      expect(amara.errors()).toEqual([]);
      expect(amara.of('ack').map((frame) => frame.info)).toEqual([{ n: 1 }]);
    });

    it('refuses parts that come out of order', async () => {
      const { engine } = await startServer();
      const amara = await member(engine, 'u_amara');

      await amara.update('launch', { n: 1, part: [0, 3] }, new Uint8Array([1]));
      await amara.update('launch', { n: 1, part: [2, 3] }, new Uint8Array([1]));

      expect(amara.errors()).toEqual([
        expect.objectContaining({
          code: 'invalid-message',
          detail: { reason: 'the parts of an update came out of order' },
        }),
      ]);
    });

    it('refuses update info it cannot read', async () => {
      const { engine } = await startServer();
      const amara = await member(engine, 'u_amara');

      await amara.update('launch', { n: 1, part: [3, 3] }, new Uint8Array([1]));

      expect(amara.errors().map((error) => error.code)).toEqual(['validation-failed']);
    });

    it('refuses bytes that are not a Yjs update, without an internal error', async () => {
      const { engine, logged } = await startServer();
      const amara = await member(engine, 'u_amara');

      await amara.update('launch', { n: 1 }, new Uint8Array([1, 2, 3, 250, 99, 7, 7, 7]));

      expect(amara.of('refused').map((frame) => frame.info)).toEqual([
        { n: 1, reason: 'the bytes are not a Yjs update' },
      ]);
      expect(amara.errors()).toEqual([]);
      expect(logged).toEqual([]);
    });

    it('sends an update bigger than a frame may be in parts, to every member', async () => {
      const { engine } = await startServer({ sendBytes: 300_000 });
      const amara = await member(engine, 'u_amara');
      const kofi = await member(engine, 'u_kofi');
      const title = 'x'.repeat(700_000);

      await amara.edit(1, (ydoc) => ydoc.getText('title').insert(0, title));
      kofi.catchUp();
      const dave = await member(engine, 'u_dave');

      expect(amara.of('ack').map((frame) => frame.info)).toEqual([{ n: 1 }]);
      expect(kofi.of('update').length).toBeGreaterThan(1);
      expect(kofi.board.state.get().title).toBe(title);
      expect(dave.board.state.get().title).toBe(title);
      expect(dave.errors()).toEqual([]);
    });

    it('sends a big server change in parts', async () => {
      const { engine, api } = await startServer({ sendBytes: 300_000 });
      const amara = await member(engine, 'u_amara');
      const title = 'y'.repeat(700_000);

      await api()
        .doc('task-board', 'launch')
        .change((d) => {
          d.title = title;
        });
      amara.catchUp();

      expect(amara.board.state.get().title).toBe(title);
    });

    it('holds at most 32 MiB of waiting parts for one connection, across rooms', async () => {
      const { engine } = await startServer();
      const amara = await member(engine, 'u_amara');
      await amara.open('roadmap');
      const half = new Uint8Array(17 * 1024 * 1024);

      await amara.update('launch', { n: 1, part: [0, 2] }, half);
      await amara.update('roadmap', { n: 1, part: [0, 2] }, half);

      expect(amara.errors()).toEqual([
        expect.objectContaining({
          code: 'invalid-message',
          detail: {
            reason: 'the updates a client sends in parts can be at most 33554432 bytes in all',
          },
        }),
      ]);
    });
  });

  describe('storage', () => {
    it('sqlStorage numbers a new update after the stored ones, with no state of its own', async () => {
      const sql = testSql();
      const doc = { type: 'task-board', id: 'launch' };
      const board = open(taskBoard);
      const updates: Uint8Array[] = [];
      board.ydoc.on('update', (update: Uint8Array) => updates.push(update));

      board.change((d) => {
        d.title = 'Hello';
      });
      board.change((d) => {
        d.title = 'Hello world';
      });

      sqlStorage(sql).append(doc, updates[0]!);
      sqlStorage(sql).append(doc, updates[1]!);
      const reloaded = new Y.Doc();
      for (const update of await sqlStorage(sql).load(doc)) Y.applyUpdate(reloaded, update);

      expect(open(taskBoard, reloaded).state.get().title).toBe('Hello world');
    });

    it('keeps a doc in the server SQL, so a new server loads it, and adds a metadata column', async () => {
      const sql = testSql();
      const first = await startServer({ sql });
      const amara = await member(first.engine, 'u_amara');
      await amara.edit(1, (ydoc) => ydoc.getText('title').insert(0, 'Launch'));

      const second = await startServer({ sql });

      expect((await second.api().doc('task-board', 'launch').read()).title).toBe('Launch');
      expect(
        sql.exec<{ name: string }>('PRAGMA table_info(livething_collaboration_updates)').toArray(),
      ).toContainEqual(expect.objectContaining({ name: 'metadata' }));
    });

    it('splits an update bigger than a row across rows, and loads it back whole', async () => {
      const sql = testSql(2048);
      const first = await startServer({ sql });
      const title = 'x'.repeat(5000);
      await first
        .api()
        .doc('task-board', 'launch')
        .change((d) => {
          d.title = title;
        });
      await settle();

      const rows = sql.exec('SELECT * FROM livething_collaboration_updates').toArray();

      expect(rows.length).toBeGreaterThan(1);
      const second = await startServer({ sql });

      expect((await second.api().doc('task-board', 'launch').read()).title).toBe(title);
    });

    it('compacts the stored updates into one after 200 of them', async () => {
      const { storage, docs, calls } = memoryStorage();
      const { api } = await startServer({ storage });
      const launch = api().doc('task-board', 'launch');

      for (let index = 0; index < 200; index += 1) {
        await launch.change((d) => {
          d.title = `v${index}`;
        });
      }

      expect(calls.filter((call) => call === 'compact')).toHaveLength(1);
      expect(docs.get('task-board:launch')).toHaveLength(1);

      const reloaded = new Y.Doc();
      Y.applyUpdate(reloaded, docs.get('task-board:launch')![0]!);
      expect(open(taskBoard, reloaded).state.get().title).toBe('v199');
    });

    it('unloads a doc when its last member leaves, and loads it again on the next open', async () => {
      const { storage, calls } = memoryStorage();
      const { engine } = await startServer({ storage });
      const amara = await member(engine, 'u_amara');
      const kofi = await member(engine, 'u_kofi');

      await amara.leave('launch');
      await settle();
      expect(calls.filter((call) => call.startsWith('load'))).toHaveLength(1);

      await kofi.leave('launch');
      await settle();
      await member(engine, 'u_amara');

      expect(calls.filter((call) => call.startsWith('load'))).toHaveLength(2);
    });

    it('after a failed store, logs it, acks the live edit, and stores the whole doc next', async () => {
      const { storage, docs } = memoryStorage();
      let failures = 1;
      const flaky: ServerStorage = {
        ...storage,
        append(doc, update) {
          if (failures-- > 0) throw new Error('disk full');

          return storage.append(doc, update);
        },
      };

      const { engine, logged } = await startServer({ storage: flaky });
      const amara = await member(engine, 'u_amara');

      await amara.edit(1, (ydoc) => ydoc.getText('title').insert(0, 'Hello'));
      await amara.edit(2, (ydoc) => ydoc.getText('title').insert(5, ' world'));
      const reloaded = await startServer({ storage: memoryStorage(docs).storage });

      expect(amara.of('ack').map((frame) => frame.info)).toEqual([{ n: 1 }, { n: 2 }]);
      expect(amara.of('refused')).toEqual([]);
      expect(JSON.stringify(logged)).toContain('disk full');
      expect((await reloaded.api().doc('task-board', 'launch').read()).title).toBe('Hello world');
    });

    it('keeps a doc it could not store loaded, and stores it when the last member leaves', async () => {
      const { storage, docs } = memoryStorage();
      let failing = true;
      const flaky: ServerStorage = {
        ...storage,
        append(doc, update) {
          if (failing) throw new Error('disk full');

          return storage.append(doc, update);
        },
        compact(doc, state) {
          if (failing) throw new Error('disk full');

          return storage.compact(doc, state);
        },
      };

      const { engine } = await startServer({ storage: flaky });
      const amara = await member(engine, 'u_amara');
      await amara.edit(1, (ydoc) => ydoc.getText('title').insert(0, 'Hello'));

      await amara.leave('launch');
      await settle();

      failing = false;
      const kofi = await member(engine, 'u_kofi');
      await kofi.leave('launch');
      await settle();

      const reloaded = await startServer({ storage: memoryStorage(docs).storage });

      expect(kofi.board.state.get().title).toBe('Hello');
      expect((await reloaded.api().doc('task-board', 'launch').read()).title).toBe('Hello');
    });
  });

  describe('onSave', () => {
    it('runs once after the changes settle, with the doc and its content', async () => {
      const onSave = vi.fn();
      const { api } = await startServer({ onSave, saveDelayMs: 20 });
      const launch = api().doc('task-board', 'launch');

      await launch.change((d) => {
        d.title = 'Launch';
      });
      await launch.change((d) => {
        d.archived = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 60));

      expect(onSave).toHaveBeenCalledTimes(1);
      expect(onSave).toHaveBeenCalledWith(
        { log: expect.any(Object), platform: {} },
        {
          type: 'task-board',
          id: 'launch',
          state: expect.objectContaining({ title: 'Launch', archived: true }),
        },
      );
    });

    it('runs at once when the last member leaves before the delay', async () => {
      const onSave = vi.fn();
      const { engine } = await startServer({ onSave, saveDelayMs: 60_000 });
      const amara = await member(engine, 'u_amara');
      await amara.edit(1, (ydoc) => ydoc.getText('title').insert(0, 'Hi'));

      await amara.leave('launch');
      await settle();
      await settle();

      expect(onSave).toHaveBeenCalledTimes(1);
    });

    it('logs an onSave that throws', async () => {
      const { api, logged } = await startServer({
        saveDelayMs: 0,
        onSave() {
          throw new Error('webhook down');
        },
      });

      await api()
        .doc('task-board', 'launch')
        .change((d) => {
          d.title = 'Launch';
        });
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(JSON.stringify(logged)).toContain('webhook down');
    });
  });

  describe('awareness', () => {
    function state(locks: string[] = [], user: unknown = { viewingTaskId: null }) {
      return { user, yjs: 7, editor: null, locks };
    }

    it('sends a state to the others, and checks the app part with the doc type schema', async () => {
      const { engine } = await startServer();
      const amara = await member(engine, 'u_amara');
      const kofi = await member(engine, 'u_kofi');

      await amara.aware('launch', state([], { viewingTaskId: 't1' }));
      await kofi.aware('launch', state([], { viewingTaskId: 42 }));

      expect(kofi.of('__awareness__').at(-1)?.info).toMatchObject({
        changes: [{ connectionId: amara.id, state: state([], { viewingTaskId: 't1' }) }],
      });
      expect(kofi.errors().map((error) => error.code)).toEqual(['awareness-refused']);
    });

    it('lets one member hold a lock, refuses it to a second, and frees it when the first leaves', async () => {
      const { engine } = await startServer();
      const amara = await member(engine, 'u_amara');
      const kofi = await member(engine, 'u_kofi');

      await amara.aware('launch', state(['task:t1']));
      await kofi.aware('launch', state(['task:t1']));
      expect(kofi.errors().map((error) => error.code)).toEqual(['awareness-refused']);

      await amara.leave('launch');
      await kofi.aware('launch', state(['task:t1']));
      expect(kofi.errors()).toHaveLength(1);
    });

    it("refuses a lock from a 'view' client", async () => {
      const { engine } = await startServer();
      const guest = await member(engine, 'u_guest');

      await guest.aware('launch', state(['task:t1']));
      await guest.aware('launch', state());

      expect(guest.errors().map((error) => error.code)).toEqual(['awareness-refused']);
    });

    it('takes a state whose app part is null: a member that set none yet', async () => {
      const { engine } = await startServer();
      const amara = await member(engine, 'u_amara');

      await amara.aware('launch', state(['task:t1'], null));

      expect(amara.errors()).toEqual([]);
    });

    it('takes a state with a 32-lock list', async () => {
      const { engine } = await startServer();
      const amara = await member(engine, 'u_amara');
      const locks = Array.from({ length: 32 }, (_, index) => `${index}`.padStart(128, 'k'));

      await amara.aware('launch', state(locks));

      expect(amara.errors()).toEqual([]);
    });

    it('counts a lock key in bytes, so 32 keys of the longest length always fit', async () => {
      const { engine } = await startServer();
      const amara = await member(engine, 'u_amara');
      const longest = Array.from({ length: 32 }, (_, index) => `${index}`.padStart(64, 'é'));
      const tooLong = ['é'.repeat(65)];

      await amara.aware('launch', state(longest));
      await amara.aware('launch', state(tooLong));

      expect(amara.errors().map((error) => error.detail)).toEqual([
        expect.objectContaining({ reason: 'invalid' }),
      ]);
    });
  });

  describe('server and admin editing', () => {
    it('sends a server change to every member and stores it', async () => {
      const { storage, calls } = memoryStorage();
      const { engine, api } = await startServer({ storage });
      const amara = await member(engine, 'u_amara');

      const result = await api()
        .doc('task-board', 'launch')
        .change((d) => {
          d.tasks.push(task('t1'));
          return d.tasks.length;
        });
      amara.catchUp();

      expect(result).toBe(1);
      expect(amara.board.state.get().tasks.map((t) => t.id)).toEqual(['t1']);
      expect(calls).toContain('append');
    });

    it('stores nothing and sends nothing for a change that changes nothing', async () => {
      const { storage, calls } = memoryStorage();
      const { engine, api } = await startServer({ storage });
      const amara = await member(engine, 'u_amara');
      const before = amara.sent.length;

      await api()
        .doc('task-board', 'launch')
        .change(() => {});

      expect(calls).not.toContain('append');
      expect(amara.sent.slice(before)).toEqual([]);
    });

    it('rejects a change that breaks the schema, and keeps the doc as it was', async () => {
      const { api } = await startServer();
      const launch = api().doc('task-board', 'launch');

      await expect(
        launch.change((d) => {
          (d as { archived: unknown }).archived = 'yes';
        }),
      ).rejects.toMatchObject({ code: 'invalid-change' });
      expect((await launch.read()).archived).toBe(false);
    });

    it('refuses a doc type it does not serve and a bad doc ID', async () => {
      const { api } = await startServer();

      expect(() => api().doc('poll' as never, 'x')).toThrow("there is no doc type 'poll'");
      expect(() => api().doc('task-board', '')).toThrow(/doc ID/);
      expect(() => api().doc('task-board', 'x'.repeat(300))).toThrow(/doc ID/);
    });
  });

  describe('versions', () => {
    /** The version bytes the server sent as `version` parts for read `n`, as a Y.Doc. */
    function versionSent(
      client: { of(event: string): { info: unknown; bytes?: Uint8Array }[] },
      n: number,
    ) {
      const parts = client.of('version').filter((frame) => (frame.info as { n: number }).n === n);
      const ydoc = new Y.Doc();
      Y.applyUpdate(ydoc, joinBytes(parts.map((frame) => frame.bytes!)));
      return { parts, board: open(taskBoard, ydoc) };
    }

    it('saves, lists newest first, reads and restores versions from server code', async () => {
      const { engine, api } = await startServer();
      const amara = await member(engine, 'u_amara');
      const launch = api().doc('task-board', 'launch');
      await launch.change((d) => {
        d.title = 'Launch';
        d.tasks.push(task('t1'));
      });
      const first = await launch.versions.save('Before the review');

      await launch.change((d) => {
        d.title = 'Launch, reviewed';
      });
      await launch.versions.save('After the review', { author: 'u_kofi' });
      await launch.change((d) => {
        d.title = 'Scrapped';
        d.tasks.delete(0, 1);
      });

      expect(first).toEqual({
        id: expect.any(String),
        label: 'Before the review',
        createdAt: expect.any(Number),
        author: null,
      });
      expect((await launch.versions.list()).map((v) => [v.label, v.author])).toEqual([
        ['After the review', 'u_kofi'],
        ['Before the review', null],
      ]);
      expect(await launch.versions.read(first.id)).toMatchObject({
        title: 'Launch',
        tasks: [{ id: 't1' }],
      });

      await launch.versions.restore(first.id);
      amara.catchUp();

      expect(amara.board.state.get()).toMatchObject({ title: 'Launch', tasks: [{ id: 't1' }] });
      expect((await launch.read()).title).toBe('Launch');
    });

    it('refuses a version ID it does not have, and a label that is empty or too long', async () => {
      const { api } = await startServer();
      const launch = api().doc('task-board', 'launch');

      await expect(launch.versions.read('v_none')).rejects.toMatchObject({
        code: 'version-not-found',
        detail: { type: 'task-board', id: 'launch', version: 'v_none' },
      });
      await expect(launch.versions.restore('v_none')).rejects.toMatchObject({
        code: 'version-not-found',
      });
      await expect(launch.versions.save('')).rejects.toThrow(/label/);
      await expect(launch.versions.save('x'.repeat(201))).rejects.toThrow(/label/);
    });

    it('lets an editor save a version as its author, and a viewer list and read them', async () => {
      const { engine, api } = await startServer();
      await api()
        .doc('task-board', 'launch')
        .change((d) => {
          d.title = 'Launch';
        });
      const amara = await member(engine, 'u_amara');
      const guest = await member(engine, 'u_guest');

      const saved = await amara.request('launch', 'save-version', { label: 'Draft' });
      const info = saved?.info as { id: string };
      const listed = await guest.request('launch', 'list-versions', null);
      const read = await guest.binaryRequest('launch', 'read-version', { id: info.id, n: 1 });

      expect(saved?.info).toEqual({
        id: expect.any(String),
        label: 'Draft',
        createdAt: expect.any(Number),
        author: 'u_amara',
      });
      expect(listed?.info).toEqual({ versions: [saved?.info] });
      expect(read?.info).toBeNull();
      expect(versionSent(guest, 1).board.state.get().title).toBe('Launch');
      expect(guest.errors()).toEqual([]);
    });

    it('refuses a save from a viewer, a bad label, and a version ID it does not have', async () => {
      const { engine } = await startServer();
      const amara = await member(engine, 'u_amara');
      const guest = await member(engine, 'u_guest');

      await guest.request('launch', 'save-version', { label: 'Draft' });
      await amara.request('launch', 'save-version', { label: '' });
      await amara.request('launch', 'save-version', { label: 'x'.repeat(201) });
      await amara.binaryRequest('launch', 'read-version', { id: 'v_none', n: 1 });

      expect(guest.errors().map((error) => error.code)).toEqual(['access-denied']);
      expect(amara.errors()).toEqual([
        expect.objectContaining({ code: 'validation-failed' }),
        expect.objectContaining({ code: 'validation-failed' }),
        expect.objectContaining({
          code: 'version-not-found',
          detail: { type: 'task-board', id: 'launch', version: 'v_none' },
        }),
      ]);
    });

    it('sends a big version in parts before the answer', async () => {
      const { engine, api } = await startServer({ sendBytes: 300_000 });
      const title = 'x'.repeat(700_000);
      const launch = api().doc('task-board', 'launch');
      await launch.change((d) => {
        d.title = title;
      });
      const saved = await launch.versions.save('Long title');

      const amara = await member(engine, 'u_amara');

      await amara.binaryRequest('launch', 'read-version', { id: saved.id, n: 7 });
      const { parts, board } = versionSent(amara, 7);

      expect(parts.length).toBeGreaterThan(1);
      expect(board.state.get().title).toBe(title);
      expect(amara.errors()).toEqual([]);
    });

    it('keeps versions in the server SQL across servers, in rows with a metadata column', async () => {
      const sql = testSql(2048);
      const first = await startServer({ sql });
      const title = 'x'.repeat(5000);
      await first
        .api()
        .doc('task-board', 'launch')
        .change((d) => {
          d.title = title;
        });
      const saved = await first.api().doc('task-board', 'launch').versions.save('Long title');

      const second = await startServer({ sql });
      const launch = second.api().doc('task-board', 'launch');

      expect(await launch.versions.list()).toEqual([saved]);
      expect((await launch.versions.read(saved.id)).title).toBe(title);
      for (const table of [
        'livething_collaboration_versions',
        'livething_collaboration_version_parts',
      ]) {
        expect(sql.exec<{ name: string }>(`PRAGMA table_info(${table})`).toArray()).toContainEqual(
          expect.objectContaining({ name: 'metadata' }),
        );
      }

      expect(
        sql.exec('SELECT * FROM livething_collaboration_version_parts').toArray().length,
      ).toBeGreaterThan(1);
    });
  });

  describe('setup', () => {
    it('refuses a doc type listed twice, no doc types, and a bad saveDelayMs', () => {
      function access() {
        return 'edit' as const;
      }

      expect(() => collaboration({ docs: [taskBoard, taskBoard], access })).toThrow(/listed twice/);
      expect(() => collaboration({ docs: [], access })).toThrow(/at least one/);
      expect(() => collaboration({ docs: [taskBoard], access, saveDelayMs: -1 })).toThrow(
        /saveDelayMs/,
      );
    });
  });

  describe('hibernation', () => {
    it('keeps a woken member able to edit, with the access it had', async () => {
      const sql = testSql();
      const first = await startServer({ sql, hibernation: true });
      const socket = { id: 'socket-amara' };
      const amara = await connect(first.engine, 'u_amara', socket);
      await amara.open('launch');

      await amara.sync('launch', Y.encodeStateVector(new Y.Doc()));

      const second = await startServer({ sql, hibernation: true });
      await second.engine.initialize();
      await second.engine.restoreHibernatedConnections([socket]);
      const woken = second.engine.handleHibernationWake(socket);
      const board = open(taskBoard);

      const before = Y.encodeStateVector(board.ydoc);
      board.ydoc.getText('title').insert(0, 'Woken');
      await woken.handleBinaryMessage(
        encodeBinaryFrame(
          JSON.stringify([
            '__livething:collaboration::update',
            { n: 1 },
            { channel: { name: 'task-board:launch', family: '__livething:collaboration::docs' } },
          ]),
          Y.encodeStateAsUpdate(board.ydoc, before),
        ),
      );
      await settle();

      expect((await second.api().doc('task-board', 'launch').read()).title).toBe('Woken');
    });
  });
});
