import { DocRegistry } from '~/server/registry.ts';
import { open, taskBoard } from '~/test/task-board.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import type { RegistryOptions } from '~/server/registry.ts';
import type { CollaborationStorage } from '~/server/storage.ts';

const launch = { type: 'task-board', id: 'launch' };

/** A registry over storage in memory that fails while `failing` is set. */
function setup(members: () => number = () => 0) {
  const stored: Uint8Array[] = [];
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
    broadcast: () => {},
    members,
    saveDelayMs: 10,
    reportError: (message) => errors.push(message),
  };

  /** The title the stored updates give. */
  function storedTitle(): string {
    const ydoc = new Y.Doc();
    for (const update of stored) Y.applyUpdate(ydoc, update);

    return open(taskBoard, ydoc).state.get().title;
  }

  return { registry: new DocRegistry(options), state, errors, storedTitle };
}

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
