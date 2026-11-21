import { DocRegistry } from '~/server/registry.ts';
import { cycleUpdate, forwardUpdate } from '~/test/raw-update.ts';
import { open, taskBoard } from '~/test/task-board.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import type { CollaborationStorage, DocRef } from '~/doc/storage.ts';
import type { Draft } from '~/schema.ts';
import type { LoadedDoc, RegistryOptions } from '~/server/registry.ts';

const launch = { type: 'task-board', id: 'launch' };

/** Stored saves as timers, where the plugin keeps them as scheduled tasks. */
function timerSaves(registry: () => DocRegistry) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  return {
    scheduleSave(doc: DocRef, time: number) {
      const key = `${doc.type}:${doc.id}`;
      clearTimeout(timers.get(key));
      timers.set(
        key,
        setTimeout(() => void registry().runDueSave(doc), Math.max(0, time - Date.now())),
      );
    },
    cancelSave(doc: DocRef) {
      clearTimeout(timers.get(`${doc.type}:${doc.id}`));
    },
  };
}

/** A registry over storage in memory that fails while `failing` is set. */
function setup(members: () => number = () => 0) {
  const stored: Uint8Array[] = [];
  const sent: Uint8Array[] = [];
  const errors: string[] = [];
  const state = { failing: false, loads: 0 };
  const storage: CollaborationStorage = {
    load() {
      state.loads += 1;
      return [...stored];
    },
    append(_doc, update) {
      if (state.failing) throw new Error('disk full');

      stored.push(update);
    },
    compact(_doc, whole) {
      if (state.failing) throw new Error('disk full');

      stored.splice(0, stored.length, whole);
    },
  };

  const options: RegistryOptions = {
    defs: new Map([[taskBoard.name, taskBoard]]),
    storage,
    broadcast: (_doc, update) => sent.push(update),
    members,
    saveDelayMs: 10,
    reportError: (message) => errors.push(message),
    ...timerSaves(() => registry),
  };

  const registry = new DocRegistry(options);

  /** The title the stored updates give. */
  function storedTitle(): string {
    const ydoc = new Y.Doc();
    for (const update of stored) Y.applyUpdate(ydoc, update);

    return open(taskBoard, ydoc).state.get().title;
  }

  return { registry, state, errors, storedTitle, stored, sent };
}

describe('DocRegistry changes', () => {
  it('sends and stores the rollback of a change that throws, so later changes still apply', async () => {
    const { registry, stored, sent } = setup();
    function change(mutate: (d: Draft<typeof taskBoard.shape>) => void) {
      return registry.change(launch, mutate as never);
    }

    await change((d) => {
      d.title = 'one';
    });
    await expect(
      change((d) => {
        d.archived = true;
        d.columns.push({ id: 'todo', name: 'To do' });
        throw new Error('stop');
      }),
    ).rejects.toThrow('stop');
    await change((d) => {
      d.title = 'three';
    });

    for (const updates of [sent, stored]) {
      const copy = new Y.Doc();
      for (const update of updates) Y.applyUpdate(copy, update);

      expect(copy.store.pendingStructs).toBeNull();
      expect(open(taskBoard, copy).state.get()).toMatchObject({
        title: 'three',
        archived: false,
        columns: [],
      });
    }
  });
});

describe('DocRegistry loading', () => {
  it.each([
    ['one that throws in Yjs', forwardUpdate(777, 'title')],
    ['one Yjs holds back', cycleUpdate()],
  ])('loads a doc whose stored log has a broken update (%s), and reports it', async (_, broken) => {
    const good = new Y.Doc();
    good.getText('title').insert(0, 'Launch');
    const stored = [Y.encodeStateAsUpdate(good), broken];
    const errors: string[] = [];
    const registry: DocRegistry = new DocRegistry({
      defs: new Map([[taskBoard.name, taskBoard]]),
      storage: { load: () => stored, append() {}, compact() {} },
      broadcast: () => {},
      members: () => 1,
      saveDelayMs: 10,
      reportError: (message) => errors.push(message),
      ...timerSaves(() => registry),
    });

    const snapshot = await registry.read(launch);

    // The doc opens with the updates that apply whole, and no part of the broken one.
    expect((snapshot as { title: string }).title).toBe('Launch');
    expect(errors).toHaveLength(1);
    await registry.with(launch, (doc) => {
      expect(doc.core.ydoc.store.pendingStructs).toBeNull();
    });
  });

  it('skips a stored update cut off at the end whole, not just the part after the cut', async () => {
    const writer = open(taskBoard);
    writer.change((d) => {
      d.title = 'Launch';
    });
    const first = Y.encodeStateAsUpdate(writer.ydoc);
    const before = Y.encodeStateVector(writer.ydoc);
    writer.change((d) => {
      d.title = 'Launch plan';
    });

    const second = Y.encodeStateAsUpdate(writer.ydoc, before);
    const errors: string[] = [];
    const registry: DocRegistry = new DocRegistry({
      defs: new Map([[taskBoard.name, taskBoard]]),
      storage: { load: () => [first, second.slice(0, -1)], append() {}, compact() {} },
      broadcast() {},
      members: () => 1,
      saveDelayMs: 10,
      reportError: (message) => errors.push(message),
      ...timerSaves(() => registry),
    });

    expect((await registry.read(launch)).title).toBe('Launch');
    expect(errors).toEqual([expect.stringMatching(/does not apply/)]);
  });
});

describe('DocRegistry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('gives a call that starts while the doc unloads a loaded doc, not the one unloading', async () => {
    let checks = 0;
    let started: Promise<unknown> | null = null;
    const seen: unknown[] = [];
    const { registry } = setup(() => {
      checks += 1;
      // The last idle check of the unload: a call starts in the same turn.
      if (checks === 2) started = registry.with(launch, (doc) => seen.push(doc));
      return 0;
    });

    await registry.read(launch);
    await vi.advanceTimersByTimeAsync(0);
    await started;
    const now = await registry.with(launch, (doc) => doc);

    expect(seen).toEqual([now]);
  });

  it('tries again to store a doc it kept loaded, even with nobody left to use it', async () => {
    const { registry, state, errors, storedTitle } = setup();
    state.failing = true;
    await registry.change(launch, (d) => {
      (d as { title: string }).title = 'Hello';
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(errors.length).toBeGreaterThan(0);

    state.failing = false;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(storedTitle()).toBe('Hello');
    const loads = state.loads;
    await registry.read(launch);
    expect(state.loads).toBe(loads + 1);
  });
});

describe('DocRegistry sending', () => {
  it('stores a change even when sending it to the members throws', async () => {
    const { registry, storedTitle } = setup(() => 1);
    const options = (registry as unknown as { options: { broadcast: () => void } }).options;
    options.broadcast = () => {
      throw new Error('frame over the send limit');
    };

    await expect(
      registry.change(launch, (d) => {
        (d as { title: string }).title = 'Stored anyway';
      }),
    ).rejects.toThrow('send limit');

    expect(storedTitle()).toBe('Stored anyway');
  });
});

describe('DocRegistry receive', () => {
  it('stores the whole doc after a failed write, even when the next update changes nothing', async () => {
    const { registry, state, storedTitle } = setup(() => 1);
    const client = open(taskBoard);
    client.change((d) => {
      d.title = 'Kept';
    });
    const update = Y.encodeStateAsUpdate(client.ydoc);

    state.failing = true;
    await registry.receive(launch, update, { editor: null, applied() {} });
    state.failing = false;
    await registry.receive(launch, update, { editor: null, applied() {} });

    expect(storedTitle()).toBe('Kept');
  });
});

describe('DocRegistry saves', () => {
  it('runs one onSave at a time for a doc, even when one takes longer than the delay', async () => {
    const { registry } = setup(() => 1);
    let running = 0;
    let most = 0;
    const saved: string[] = [];

    const options = (registry as unknown as { options: { onSave: unknown } }).options;
    options.onSave = async (_doc: unknown, state: { title: string }) => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 100));
      saved.push(state.title);
      running -= 1;
    };

    await registry.change(launch, (d) => {
      (d as { title: string }).title = 'First';
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    await registry.change(launch, (d) => {
      (d as { title: string }).title = 'Second';
    });
    await registry.flush();

    expect(most).toBe(1);
    expect(saved).toEqual(['First', 'Second']);
  });
});

describe('DocRegistry saves with no members', () => {
  it('runs one onSave at a time across an unload and a new load', async () => {
    const { registry } = setup(() => 0);
    let running = 0;
    let most = 0;
    const saved: string[] = [];

    const options = (registry as unknown as { options: { onSave: unknown } }).options;
    options.onSave = async (_doc: unknown, state: { title: string }) => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 100));
      saved.push(state.title);
      running -= 1;
    };

    function rename(title: string) {
      return registry.change(launch, (d) => {
        (d as { title: string }).title = title;
      });
    }

    // A's save runs; B's queues behind it; the doc may unload; C loads it again.
    await rename('A');
    await new Promise((resolve) => setTimeout(resolve, 50));
    await rename('B');
    await new Promise((resolve) => setTimeout(resolve, 62));

    await rename('C');
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(most).toBe(1);
    expect(saved.at(-1)).toBe('C');
  });
});

describe('DocRegistry.flush() and a load that never ends', () => {
  it('still ends after its time limit, and logs it', async () => {
    const errors: string[] = [];
    const registry: DocRegistry = new DocRegistry({
      defs: new Map([[taskBoard.name, taskBoard]]),
      storage: { load: () => new Promise(() => {}), append() {}, compact() {} },
      broadcast() {},
      members: () => 1,
      saveDelayMs: 10,
      reportError: (message) => errors.push(message),
      ...timerSaves(() => registry),
    });
    void registry.read(launch);

    vi.useFakeTimers();
    try {
      const flushing = registry.flush();
      await vi.advanceTimersByTimeAsync(10_000);
      await flushing;
    } finally {
      vi.useRealTimers();
    }

    expect(errors.join()).toMatch(/stopped before every doc was stored/);
  });
});

describe('DocRegistry, onLoad', () => {
  it('keeps no change of an onLoad that throws after it, so the next load starts empty again', async () => {
    const stored: Uint8Array[] = [];
    const sent: Uint8Array[] = [];
    const empties: boolean[] = [];
    let fail = true;
    const registry: DocRegistry = new DocRegistry({
      defs: new Map([[taskBoard.name, taskBoard]]),
      storage: {
        load: () => [...stored],
        append(_doc, update) {
          stored.push(update);
        },
        compact(_doc, whole) {
          stored.splice(0, stored.length, whole);
        },
      },
      broadcast: (_doc, update) => sent.push(update),
      members: () => 0,
      saveDelayMs: 10,
      reportError() {},
      ...timerSaves(() => registry),
      onLoad(_doc, loaded) {
        empties.push(loaded.empty);
        loaded.change((d) => {
          (d as { title: string }).title = 'Half of the board';
        });
        if (fail) throw new Error('the second table is down');
      },
    });

    await expect(registry.read(launch)).rejects.toThrow('the second table is down');
    expect({ stored: stored.length, sent: sent.length }).toEqual({ stored: 0, sent: 0 });

    fail = false;
    expect(await registry.read(launch)).toMatchObject({ title: 'Half of the board' });
    expect(empties).toEqual([true, true]);
  });

  it('still loads, with its changes stored, when sending them to the room fails', async () => {
    const stored: Uint8Array[] = [];
    const errors: string[] = [];
    const registry: DocRegistry = new DocRegistry({
      defs: new Map([[taskBoard.name, taskBoard]]),
      storage: {
        load: () => [...stored],
        append(_doc, update) {
          stored.push(update);
        },
        compact(_doc, whole) {
          stored.splice(0, stored.length, whole);
        },
      },
      broadcast() {
        throw new Error('the room is gone');
      },
      members: () => 0,
      saveDelayMs: 10,
      reportError: (message) => errors.push(message),
      ...timerSaves(() => registry),
      onLoad(_doc, loaded) {
        loaded.change((d) => {
          (d as { title: string }).title = 'Filled';
        });
      },
    });

    expect(await registry.read(launch)).toMatchObject({ title: 'Filled' });
    expect(stored).toHaveLength(1);
    expect(errors).toEqual([expect.stringMatching(/could not send/)]);
  });

  it('refuses a change and a read of the doc it was given once onLoad ended', async () => {
    let kept!: LoadedDoc;
    const registry: DocRegistry = new DocRegistry({
      defs: new Map([[taskBoard.name, taskBoard]]),
      storage: { load: () => [], append() {}, compact() {} },
      broadcast() {},
      members: () => 1,
      saveDelayMs: 10,
      reportError() {},
      ...timerSaves(() => registry),
      onLoad(_doc, loaded) {
        kept = loaded;
      },
    });
    await registry.read(launch);

    expect(() => kept.change(() => {})).toThrow(/onLoad ended/);
    expect(() => kept.state()).toThrow(/onLoad ended/);
  });
});

describe('DocRegistry editors', () => {
  /** A registry whose editor store takes 30 ms a write, and counts the writes still running. */
  function slowEditors(load: () => readonly string[] = () => []) {
    const kept = { editors: [] as readonly string[], writing: 0, loads: [] as number[] };
    const errors: string[] = [];
    const registry: DocRegistry = new DocRegistry({
      defs: new Map([[taskBoard.name, taskBoard]]),
      storage: { load: () => [], append() {}, compact() {} },
      broadcast() {},
      members: () => 0,
      saveDelayMs: 10,
      reportError: (message) => errors.push(message),
      ...timerSaves(() => registry),
      onSave() {},
      editors: {
        load() {
          kept.loads.push(kept.writing);
          return load();
        },
        async store(_doc, editors) {
          kept.writing += 1;
          await new Promise((resolve) => setTimeout(resolve, 30));
          kept.editors = editors;
          kept.writing -= 1;
        },
      },
    });
    const client = open(taskBoard);
    client.change((d) => {
      d.title = 'Launch';
    });

    return { registry, kept, errors, update: Y.encodeStateAsUpdate(client.ydoc) };
  }

  it('unloads a doc only once its editors are kept, so the next load reads them', async () => {
    const { registry, kept, update } = slowEditors();
    await registry.receive(launch, update, { editor: 'u_amara', applied() {} });

    registry.release(launch);
    await new Promise((resolve) => setTimeout(resolve, 15));
    await registry.read(launch);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await registry.read(launch);

    expect(kept.loads).toEqual([0, 0]);
  });

  it('keeps the editors before a flush ends', async () => {
    const { registry, kept, update } = slowEditors();
    await registry.receive(launch, update, { editor: 'u_amara', applied() {} });

    await registry.flush();

    expect(kept).toMatchObject({ writing: 0, editors: [] });
  });

  it('still loads the doc when its editors can not be read, and logs it', async () => {
    const { registry, errors } = slowEditors(() => {
      throw new Error('kv is down');
    });

    expect(await registry.read(launch)).toMatchObject({ title: '' });
    expect(errors).toEqual([expect.stringMatching(/editors/)]);
  });
});

describe('DocRegistry.runDueSave()', () => {
  it('saves once for two stored saves of a doc that loads after a restart', async () => {
    const saves: string[] = [];
    const registry: DocRegistry = new DocRegistry({
      defs: new Map([[taskBoard.name, taskBoard]]),
      storage: { load: () => [], append() {}, compact() {} },
      broadcast() {},
      members: () => 0,
      saveDelayMs: 10,
      reportError() {},
      ...timerSaves(() => registry),
      onSave(doc) {
        saves.push(doc.id);
      },
    });

    await Promise.all([registry.runDueSave(launch), registry.runDueSave(launch)]);

    expect(saves).toEqual(['launch']);
  });

  it('does not end before an onSave that is still running, so its stored save stays until then', async () => {
    const order: string[] = [];
    const registry: DocRegistry = new DocRegistry({
      defs: new Map([[taskBoard.name, taskBoard]]),
      storage: { load: () => [], append() {}, compact() {} },
      broadcast() {},
      members: () => 1,
      saveDelayMs: 60_000,
      reportError() {},
      scheduleSave() {},
      cancelSave() {},
      async onSave() {
        order.push('onSave started');
        await new Promise((resolve) => setTimeout(resolve, 100));
        order.push('onSave ended');
      },
    });
    await registry.change(launch, (d) => {
      (d as { title: string }).title = 'Launch';
    });

    const flushing = registry.flush();
    await vi.waitFor(() => expect(order).toEqual(['onSave started']));
    await registry.runDueSave(launch);
    order.push('stored save ended');
    await flushing;

    expect(order).toEqual(['onSave started', 'onSave ended', 'stored save ended']);
  });
});

describe('DocRegistry.flush()', () => {
  it('stores a doc whose last write failed, while a member keeps it loaded', async () => {
    const { registry, state, storedTitle } = setup(() => 1);
    state.failing = true;
    await registry.change(launch, (d) => {
      (d as { title: string }).title = 'Kept';
    });
    state.failing = false;

    await registry.flush();

    expect(storedTitle()).toBe('Kept');
  });

  it('tries a failed write once, not again and again, when storage keeps failing', async () => {
    const { registry, state, errors } = setup(() => 1);
    await registry.change(launch, (d) => {
      (d as { title: string }).title = 'Kept in memory';
    });
    state.failing = true;
    await registry.change(launch, (d) => {
      (d as { title: string }).title = 'Not stored';
    });
    errors.length = 0;

    await registry.flush();

    expect(errors).toEqual([expect.stringMatching(/could not store/)]);
  });

  it('also stores a change that comes in while it runs, such as during an onSave', async () => {
    const stored: Uint8Array[] = [];
    let saves = 0;
    const registry: DocRegistry = new DocRegistry({
      defs: new Map([[taskBoard.name, taskBoard]]),
      storage: {
        load: () => [...stored],
        async append(_doc, update) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          stored.push(update);
        },
        compact(_doc, whole) {
          stored.splice(0, stored.length, whole);
        },
      },
      broadcast() {},
      members: () => 1,
      saveDelayMs: 60_000,
      reportError() {},
      ...timerSaves(() => registry),
      async onSave() {
        saves += 1;
        // A member's edit arrives while the first save runs.
        if (saves === 1) {
          void registry.change(launch, (d) => {
            (d as { title: string }).title = 'Sent during the save';
          });
        }

        await new Promise((resolve) => setTimeout(resolve, 5));
      },
    });
    await registry.change(launch, (d) => {
      (d as { title: string }).title = 'Before the flush';
    });

    await registry.flush();

    const ydoc = new Y.Doc();
    for (const update of stored) Y.applyUpdate(ydoc, update);
    expect(open(taskBoard, ydoc).state.get().title).toBe('Sent during the save');
  });
});

describe('DocRegistry.restore()', () => {
  it('refuses a version the schema now refuses, and leaves the doc as it was', async () => {
    const { registry } = setup(() => 1);
    await registry.change(launch, (d) => {
      (d as { title: string }).title = 'Launch';
    });
    const version = new Y.Doc();
    version.getMap('~').set('archived', 'yes');

    await expect(registry.restore(launch, version)).rejects.toMatchObject({
      code: 'invalid-change',
    });
    expect((await registry.read(launch)).title).toBe('Launch');
  });
});
