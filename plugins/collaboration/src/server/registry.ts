import { ChangeOrigin, DocCore } from '~/doc/core.ts';
import { checkVersion, restoreFrom } from '~/doc/restore.ts';
import { applyChecked } from '~/server/check.ts';
import * as Y from 'yjs';
import type { CollaborationStorage, DocRef } from '~/doc/storage.ts';
import type { DocDef, Draft, Snapshot } from '~/schema.ts';
import type { CheckResult } from '~/server/check.ts';

/** Compact a doc's stored updates into one after this many appends. */
const COMPACT_AFTER_UPDATES = 200;
/** Or after this many bytes of appends since the last compaction. */
const COMPACT_AFTER_BYTES = 4 * 1024 * 1024;
/** How long to wait before trying again to store a doc that could not be stored. */
const RETRY_STORE_MS = 5000;
/** The longest a shutdown waits for docs to be stored and saved. */
const FLUSH_TIMEOUT_MS = 10_000;

/** What the registry needs from the plugin. */
export interface RegistryOptions {
  readonly defs: ReadonlyMap<string, DocDef>;
  readonly storage: CollaborationStorage;
  /** Send an update to every member of a doc's room. */
  broadcast(doc: DocRef, update: Uint8Array): void;
  /** How many members a doc's room has now. */
  members(doc: DocRef): number;
  /** Runs after a doc's changes settle, `saveDelayMs` after the last one. */
  onSave?(doc: DocRef, state: unknown): void | Promise<void>;
  /** Runs each time a doc loads, before anyone reads it. A throw fails the load, keeping no change. */
  onLoad?(doc: DocRef, load: LoadedDoc): void | Promise<void>;
  readonly saveDelayMs: number;
  /**
   * Keep "save `doc` at `time`" in storage, so it runs even after the server restarts, and
   * call {@link DocRegistry.runDueSave} then. A doc can have more than one stored after a
   * restart; the extra ones find nothing new to save, and end.
   */
  scheduleSave(doc: DocRef, time: number): void;
  /** Drop the stored save of `doc`, once it ran some other way. */
  cancelSave(doc: DocRef): void;
  reportError(message: string, error: unknown): void;
}

/** A doc as it loads, for `onLoad`. */
export interface LoadedDoc {
  /** Nothing was ever stored for the doc. */
  readonly empty: boolean;
  /** The doc as stored. Throws `invalid-change` when that no longer matches the schema. */
  state(): Snapshot<DocDef['shape']>;
  /**
   * A server change, held until `onLoad` ends: then members get it, and it is stored; none is
   * kept when `onLoad` throws. It does not run `onSave`. It throws once `onLoad` ended.
   */
  change<R>(mutate: (draft: Draft<DocDef['shape']>) => R): R;
}

/** One loaded doc. */
interface OpenDoc {
  readonly ref: DocRef;
  readonly core: DocCore;
  /** Stored writes for this doc, one after another. */
  writes: Promise<void>;
  /** Rows in storage, counting the compacted state. */
  appends: number;
  /** Bytes appended since the last compaction, not counting the compacted state. */
  bytes: number;
  /** A save is stored for this doc, waiting for its time. */
  saveDue: boolean;
  /**
   * The doc changed since `onSave` last read it. Kept apart from `saveDue`, since storing the
   * save can fail: such a change still saves when the doc unloads or the server stops.
   */
  unsaved: boolean;
  /** When this server last changed the doc, or `0` when it has not since it loaded. */
  lastChange: number;
  /** A save ran, or is queued, since the doc loaded. */
  saved: boolean;
  /** How many calls use the doc now; it is not unloaded while one runs. */
  busy: number;
  /**
   * A write failed, so storage misses updates the doc holds. The next write stores the whole
   * doc, and the doc stays loaded until one does.
   */
  unstored: boolean;
  /** The timer that tries again to store an `unstored` doc nobody uses. */
  retry: ReturnType<typeof setTimeout> | null;
  /** The last member left while a call still used the doc: save at once when it ends. */
  saveWhenIdle: boolean;
  /** The `onSave` running now, if any. */
  saving: Promise<void> | null;
}

interface ReleaseOptions {
  readonly saveNow: boolean;
}

interface ApplyOptions {
  /** Schedule `onSave` for the change. */
  readonly save: boolean;
}

function keyOf(doc: DocRef): string {
  return `${doc.type}:${doc.id}`;
}

/**
 * The docs one running server has loaded. A doc loads when it is first used, and unloads when
 * its room has no members and nothing uses it, after its changes are stored and saved.
 */
export class DocRegistry {
  private readonly options: RegistryOptions;
  private readonly docs = new Map<string, Promise<OpenDoc>>();

  constructor(options: RegistryOptions) {
    this.options = options;
  }

  /** The doc type definition for `type`, or `undefined`. */
  def(type: string): DocDef | undefined {
    return this.options.defs.get(type);
  }

  /** Run `use` with a loaded doc. The doc stays loaded while it runs. */
  async with<T>(ref: DocRef, use: (doc: OpenDoc) => T | Promise<T>): Promise<T> {
    let doc: OpenDoc;
    for (;;) {
      const loading = this.open(ref);
      doc = await loading;
      // The doc may have unloaded while this call waited for it: open it again.
      if (this.docs.get(keyOf(ref)) === loading) break;
    }

    doc.busy += 1;
    try {
      return await use(doc);
    } finally {
      doc.busy -= 1;
      this.release(ref, { saveNow: false });
    }
  }

  /**
   * Apply a client's update and check it. `applied` runs at once with the result, before
   * anything is stored, so the caller can send it on in the order the server took it. The
   * promise ends when the write ran; it rejects only when the doc could not be loaded.
   */
  receive(
    ref: DocRef,
    update: Uint8Array,
    applied: (result: CheckResult) => void,
  ): Promise<CheckResult> {
    return this.with(ref, async (doc) => {
      const result = applyChecked(doc.core, update, {});
      const stored = result.ok ? result.update : result.toOthers;
      // The doc holds the update now, so it is stored even when sending it on throws.
      try {
        applied(result);
      } finally {
        if (stored) {
          await this.store(doc, stored);
        } else if (doc.unstored) {
          // Nothing new, but an earlier write failed: try again to store the whole doc.
          doc.writes = doc.writes.then(() => this.write(doc, null));
          await doc.writes;
        }
      }

      return result;
    });
  }

  /** Edit a doc on the server. Every member gets the change. */
  change<R>(ref: DocRef, mutate: (draft: Draft<DocDef['shape']>) => R): Promise<R> {
    return this.edit(ref, () => mutate);
  }

  /** Make a doc hold what `version` holds, in one change. Every member gets it. */
  restore(ref: DocRef, version: Y.Doc): Promise<void> {
    return this.edit(ref, (core) => {
      // A version the schema now refuses (it changed since the save) must not reach the doc.
      checkVersion(core.def, version);
      return () => restoreFrom(core.ydoc, version, core.def);
    });
  }

  /** The whole doc as one update. */
  state(ref: DocRef): Promise<Uint8Array> {
    return this.with(ref, (doc) => Y.encodeStateAsUpdate(doc.core.ydoc));
  }

  private edit<R>(
    ref: DocRef,
    mutateOf: (core: DocCore) => (draft: Draft<DocDef['shape']>) => R,
  ): Promise<R> {
    return this.with(ref, async (doc) => {
      try {
        return this.apply(doc, mutateOf(doc.core), { save: true });
      } finally {
        await doc.writes;
      }
    });
  }

  /**
   * Make a server change in a loaded doc: every member gets it, and it is stored (the write
   * is queued; await `doc.writes` for it). With `save`, it schedules `onSave` too.
   */
  private apply<R>(
    doc: OpenDoc,
    mutate: (draft: Draft<DocDef['shape']>) => R,
    options: ApplyOptions,
  ): R {
    const { outcome, update } = this.capture(doc, mutate);
    if (update) this.send(doc, update, options);

    if (!outcome.ok) throw outcome.error;

    return outcome.result;
  }

  /**
   * Make a change in a loaded doc, and give every update it made, merged, or `null`: a change
   * that throws is rolled back by a second transaction, and both must reach the members and
   * storage, or the server's clock runs past what they have.
   */
  private capture<R>(doc: OpenDoc, mutate: (draft: Draft<DocDef['shape']>) => R) {
    const made: Uint8Array[] = [];
    function collect(update: Uint8Array) {
      made.push(update);
    }

    doc.core.ydoc.on('update', collect);
    let outcome: { ok: true; result: R } | { ok: false; error: unknown };
    try {
      outcome = { ok: true, result: doc.core.change(mutate, new ChangeOrigin()) };
    } catch (error) {
      outcome = { ok: false, error };
    } finally {
      doc.core.ydoc.off('update', collect);
    }

    return { outcome, update: made.length > 0 ? Y.mergeUpdates(made) : null };
  }

  /** Send an update the doc holds to every member, and queue its write. */
  private send(doc: OpenDoc, update: Uint8Array, options: ApplyOptions): void {
    // The doc holds the change now, so it is stored even when sending it throws.
    try {
      this.options.broadcast(doc.ref, update);
    } finally {
      if (options.save) void this.store(doc, update);
      else doc.writes = doc.writes.then(() => this.write(doc, update));
    }
  }

  /** A doc's content as a snapshot. */
  read(ref: DocRef): Promise<Snapshot<DocDef['shape']>> {
    return this.with(ref, (doc) => doc.core.read());
  }

  /** What a client with `vector` is missing, and the server's own vector. */
  sync(ref: DocRef, vector: Uint8Array): Promise<{ missing: Uint8Array; vector: Uint8Array }> {
    return this.with(ref, (doc) => ({
      missing: Y.encodeStateAsUpdate(doc.core.ydoc, vector),
      vector: Y.encodeStateVector(doc.core.ydoc),
    }));
  }

  /**
   * A member left, or a call ended: unload the doc when nothing needs it. A save that is due
   * runs at once with `saveNow`, as when the last member leaves. Without it, the doc stays
   * loaded until the stored save runs, so server changes with no members still wait
   * `saveDelayMs`.
   */
  release(ref: DocRef, options: ReleaseOptions = { saveNow: true }): void {
    const key = keyOf(ref);
    const loading = this.docs.get(key);
    if (!loading) return;

    // Wait one turn: a member who is leaving may still be counted while its hook runs.
    void new Promise((resolve) => setTimeout(resolve, 0))
      .then(() => loading)
      .then(
        async (doc) => {
          if (!this.idle(doc)) {
            if (options.saveNow && this.options.members(doc.ref) === 0) doc.saveWhenIdle = true;
            return;
          }

          await doc.writes;
          if (doc.unstored) {
            doc.writes = doc.writes.then(() => this.write(doc, null));
            await doc.writes;
            // Unloading now would lose the edits storage misses: keep the doc, and try again.
            if (doc.unstored) {
              doc.retry ??= setTimeout(() => {
                doc.retry = null;
                this.release(ref);
              }, RETRY_STORE_MS);
              return;
            }
          }

          if (doc.saveDue || doc.unsaved) {
            // A stored save waits for its time. With none stored (storing it failed), nothing
            // would run it later: save before the doc unloads.
            if (doc.saveDue && !options.saveNow && !doc.saveWhenIdle) return;

            doc.saveWhenIdle = false;
            await this.saveNow(doc);
          }

          // Something may have opened it while the writes and the save ran.
          if (!this.idle(doc) || this.docs.get(key) !== loading) return;

          this.docs.delete(key);
          if (doc.retry) clearTimeout(doc.retry);
          doc.core.destroy();
        },
        () => {},
      )
      .catch((error: unknown) => {
        this.options.reportError(`could not unload '${key}'`, error);
      });
  }

  /**
   * The server is stopping: wait for every doc's writes, for each save already running, and
   * run every save that is due now. Storage or an `onSave` that never settles must not hold
   * the shutdown, so this gives up after `FLUSH_TIMEOUT_MS` and logs it.
   */
  async flush(): Promise<void> {
    // Members stay connected while plugins shut down, so a change can come in during a pass,
    // such as while an `onSave` runs: pass again until a pass leaves nothing to do.
    let timedOut = false;
    const done = (async () => {
      while (!timedOut && (await this.flushPass())) {
        // A pass can end without waiting on anything real, such as when storage fails at once:
        // wait for the timers, so the time limit can still end the flush.
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      return true;
    })();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), FLUSH_TIMEOUT_MS);
    });
    const finished = await Promise.race([done, late]);
    timedOut = !finished;
    clearTimeout(timer);

    if (!finished) {
      this.options.reportError(
        `the server stopped before every doc was stored and saved, after ${FLUSH_TIMEOUT_MS} ms`,
        null,
      );
    }
  }

  /**
   * One pass of {@link flush}: store and save every doc. Gives whether work came in while it
   * ran: a doc that loaded, or a write or save that was queued since.
   */
  private async flushPass(): Promise<boolean> {
    // The wait for docs still loading is inside the time limit too: a load can hang as well.
    const loaded = await Promise.allSettled(this.docs.values());
    const docs = loaded.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
    const awaited = new Map<OpenDoc, Promise<void>>();
    await Promise.all(
      docs.map(async (doc) => {
        await doc.writes;
        // A write failed earlier, so storage misses edits the doc holds: store the whole doc.
        if (doc.unstored) {
          doc.writes = doc.writes.then(() => this.write(doc, null));
          await doc.writes;
        }

        awaited.set(doc, doc.writes);
        // A save may queue behind the one running: wait until none is left.
        while (doc.saving) await doc.saving;
        if (doc.saveDue || doc.unsaved) await this.saveNow(doc);
      }),
    );

    // A doc still unstored after this pass's write is not new work: storage is failing, and
    // the error was logged. Writing again at once would only fail again.
    return (
      this.docs.size > loaded.length ||
      docs.some(
        (doc) => doc.writes !== awaited.get(doc) || doc.saving || doc.saveDue || doc.unsaved,
      )
    );
  }

  /** Nothing needs the doc: no call, no member, and no `onSave` running or queued. */
  private idle(doc: OpenDoc): boolean {
    return doc.busy === 0 && !doc.saving && this.options.members(doc.ref) === 0;
  }

  private open(ref: DocRef): Promise<OpenDoc> {
    const key = keyOf(ref);
    let loading = this.docs.get(key);
    if (!loading) {
      loading = this.load(ref);
      this.docs.set(key, loading);
      // A failed load is not cached, so the next call tries again.
      loading.catch(() => {
        if (this.docs.get(key) === loading) this.docs.delete(key);
      });
    }

    return loading;
  }

  private async load(ref: DocRef): Promise<OpenDoc> {
    const def = this.def(ref.type);
    if (!def) throw new Error(`no doc type '${ref.type}'`);

    const updates = await this.options.storage.load(ref);
    let ydoc = new Y.Doc();
    // A stored update that does not apply (written by another version, or broken) must not
    // stop the doc from opening: report it, and load the rest. Yjs applies an update as it
    // reads it, so one that throws may be half in: build the doc again from the updates that
    // applied whole. Half an edit could make the schema refuse the doc on every read.
    const applied: Uint8Array[] = [];
    for (const update of updates) {
      try {
        Y.applyUpdate(ydoc, update);
        applied.push(update);
      } catch (error) {
        this.options.reportError(`a stored update of '${keyOf(ref)}' does not apply`, error);
        ydoc = new Y.Doc();
        for (const good of applied) Y.applyUpdate(ydoc, good);
      }
    }

    if (ydoc.store.pendingStructs || ydoc.store.pendingDs) {
      ydoc.store.pendingStructs = null;
      ydoc.store.pendingDs = null;
      this.options.reportError(
        `stored updates of '${keyOf(ref)}' point at items it does not have`,
        null,
      );
    }

    const doc: OpenDoc = {
      ref,
      core: new DocCore(def, ydoc),
      writes: Promise.resolve(),
      appends: updates.length,
      bytes: updates.slice(1).reduce((size, update) => size + update.length, 0),
      saveDue: false,
      unsaved: false,
      lastChange: 0,
      saved: false,
      busy: 0,
      unstored: false,
      retry: null,
      saveWhenIdle: false,
      saving: null,
    };

    if (!this.options.onLoad) return doc;

    // Before anyone reads the doc: the app may fill it from its own database. Its changes are
    // held, and sent and stored only once it ends: a throw fails the load with none of them,
    // so nobody reads a half-filled doc, and the next use tries again from what was stored.
    const held: Uint8Array[] = [];
    let running = true;
    function checkRunning(): void {
      if (!running) {
        throw new Error(`onLoad ended for '${keyOf(ref)}': edit the doc with a server change()`);
      }
    }

    try {
      await this.options.onLoad(ref, {
        empty: updates.length === 0,
        state: () => {
          checkRunning();
          return doc.core.read();
        },
        change: (mutate) => {
          checkRunning();
          const { outcome, update } = this.capture(doc, mutate);
          if (update) held.push(update);
          if (!outcome.ok) throw outcome.error;

          return outcome.result;
        },
      });
    } catch (error) {
      running = false;
      doc.core.destroy();
      throw error;
    }

    running = false;
    // It copies in what the app already has, so it is no reason to run `onSave`. The doc holds
    // the changes now and stores them even when the room can't get them: it still loads.
    if (held.length > 0) {
      try {
        this.send(doc, Y.mergeUpdates(held), { save: false });
      } catch (error) {
        this.options.reportError(`could not send what onLoad changed in '${keyOf(ref)}'`, error);
      }
    }

    await doc.writes;

    return doc;
  }

  /** Store an update after the doc's earlier writes, and schedule the save. Never rejects. */
  private store(doc: OpenDoc, update: Uint8Array): Promise<void> {
    doc.writes = doc.writes.then(() => this.write(doc, update));
    this.scheduleSave(doc);

    return doc.writes;
  }

  /**
   * Append `update`, or store the whole doc in one update: when there is no `update`, when the
   * log has grown, or when an earlier write failed. A failure is logged and marks the doc
   * `unstored`.
   */
  private async write(doc: OpenDoc, update: Uint8Array | null): Promise<void> {
    const { storage } = this.options;
    doc.appends += 1;
    doc.bytes += update?.length ?? 0;
    try {
      const whole =
        !update ||
        doc.unstored ||
        doc.appends >= COMPACT_AFTER_UPDATES ||
        doc.bytes >= COMPACT_AFTER_BYTES;
      if (whole) {
        const state = Y.encodeStateAsUpdate(doc.core.ydoc);
        await storage.compact(doc.ref, state);
        doc.appends = 1;
        doc.bytes = 0;
      } else {
        await storage.append(doc.ref, update);
      }

      doc.unstored = false;
    } catch (error) {
      doc.unstored = true;
      this.options.reportError(
        `could not store '${keyOf(doc.ref)}'; the next write stores the whole doc`,
        error,
      );
    }
  }

  /**
   * A change landed: save `saveDelayMs` after the last one. The save is stored once, on the
   * first change, not moved on every change: each move would be a storage write. When it is
   * due, {@link runDueSave} checks whether changes came since, and waits for the rest.
   */
  private scheduleSave(doc: OpenDoc): void {
    if (!this.options.onSave) return;

    doc.lastChange = Date.now();
    doc.unsaved = true;
    if (doc.saveDue) return;

    // Storing the task writes to storage, which can fail: the change itself stands, and the
    // next change tries again.
    try {
      this.options.scheduleSave(doc.ref, doc.lastChange + this.options.saveDelayMs);
      doc.saveDue = true;
    } catch (error) {
      this.options.reportError(`could not schedule onSave for '${keyOf(doc.ref)}'`, error);
    }
  }

  /**
   * The stored save of `ref` is due. Changes that came since it was stored push it on, to
   * `saveDelayMs` after the last one. A doc that loads for it, after a restart, saves at once:
   * the save was due before the restart, and nobody has changed it since.
   */
  async runDueSave(ref: DocRef): Promise<void> {
    // A doc type the server no longer serves has nothing to save, and must not retry.
    if (!this.options.onSave || !this.def(ref.type)) return;

    await this.with(ref, async (doc) => {
      // This run used up the stored save: the next change must store a new one, whatever
      // this run does. A second stored one, left from before, only finds nothing to save.
      doc.saveDue = false;

      // Saved already since the last change, as when the last member left, or by a second
      // stored save of the same doc. Still, end only once that save has: this run ending
      // drops it from storage, and a server that stops before then must run it again.
      if (!doc.unsaved && doc.saved) {
        while (doc.saving) await doc.saving;
        return;
      }

      const time = doc.lastChange + this.options.saveDelayMs;
      if (doc.lastChange !== 0 && time > Date.now()) {
        this.options.scheduleSave(doc.ref, time);
        doc.saveDue = true;
        return;
      }

      await this.save(doc);
    });
  }

  /**
   * Save a doc whose save is stored for later now. The stored one is dropped only after
   * `onSave` ends, so a server that stops while it runs runs it again on its next start. A
   * change that came meanwhile stored its own, which stays.
   */
  private async saveNow(doc: OpenDoc): Promise<void> {
    doc.saveDue = false;
    await this.save(doc);
    // A change during `onSave` keeps the stored save: as its own, or, when storing its own
    // failed, as the only record that a save is still due.
    if (doc.saveDue || doc.unsaved) return;

    try {
      this.options.cancelSave(doc.ref);
    } catch (error) {
      // The stored save runs later and saves once more, with nothing new: a lost save is worse.
      this.options.reportError(`could not drop the stored onSave of '${keyOf(doc.ref)}'`, error);
    }
  }

  /** Run `onSave` for `doc`. `doc.saving` holds the run, so a shutdown can wait for it. */
  private save(doc: OpenDoc): Promise<void> {
    // One run at a time for each doc, in order, so a slow run never finishes after a newer
    // one. Each run reads the doc when it starts, so it saves the newest content.
    const running = (doc.saving ?? Promise.resolve()).then(() => this.runSave(doc));
    doc.saving = running;
    doc.saved = true;
    // This save covers any "save when idle" a member's leave asked for.
    doc.saveWhenIdle = false;
    void running.finally(() => {
      if (doc.saving !== running) return;

      // The last queued save ended: the doc may unload now. Unloading earlier would start a
      // second queue on the next load, and two saves could run at once.
      doc.saving = null;
      this.release(doc.ref, { saveNow: false });
    });

    return running;
  }

  private async runSave(doc: OpenDoc): Promise<void> {
    if (!this.options.onSave) return;

    // It reads the doc as it is now: a change after this point marks the doc again.
    doc.unsaved = false;
    let state: unknown;
    try {
      state = doc.core.read();
    } catch (error) {
      this.options.reportError(
        `onSave did not run for '${keyOf(doc.ref)}': its content does not match the schema`,
        error,
      );
      return;
    }

    try {
      await this.options.onSave(doc.ref, state);
    } catch (error) {
      this.options.reportError(`onSave failed for '${keyOf(doc.ref)}'`, error);
    }
  }
}
