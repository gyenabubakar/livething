import { ChangeOrigin, DocCore } from '~/doc/core.ts';
import { applyChecked } from '~/server/check.ts';
import * as Y from 'yjs';
import type { DocDef, Draft, Snapshot } from '~/schema.ts';
import type { CheckResult } from '~/server/check.ts';
import type { CollaborationStorage, DocRef } from '~/server/storage.ts';

/** Compact a doc's stored updates into one after this many appends. */
const COMPACT_AFTER_UPDATES = 200;
/** Or after this many bytes of appends. */
const COMPACT_AFTER_BYTES = 4 * 1024 * 1024;
/** How long to wait before trying again to store a doc that could not be stored. */
const RETRY_STORE_MS = 5000;

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
  readonly saveDelayMs: number;
  reportError(message: string, error: unknown): void;
}

/** One loaded doc. */
interface OpenDoc {
  readonly ref: DocRef;
  readonly core: DocCore;
  /** Stored writes for this doc, one after another. */
  writes: Promise<void>;
  appends: number;
  bytes: number;
  saveTimer: ReturnType<typeof setTimeout> | null;
  /** How many calls use the doc now; it is not unloaded while one runs. */
  busy: number;
  /**
   * A write failed, so storage misses updates the doc holds. The next write stores the whole
   * doc, and the doc stays loaded until one does.
   */
  unstored: boolean;
  /** The timer that tries again to store an `unstored` doc nobody uses. */
  retry: ReturnType<typeof setTimeout> | null;
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
      this.release(ref);
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
      applied(result);
      const stored = result.ok ? result.update : result.toOthers;
      if (stored) await this.store(doc, stored);

      return result;
    });
  }

  /** Edit a doc on the server. Every member gets the change. */
  change<R>(ref: DocRef, mutate: (draft: Draft<DocDef['shape']>) => R): Promise<R> {
    return this.with(ref, async (doc) => {
      const origin = new ChangeOrigin();
      let made: Uint8Array | null = null;
      function capture(update: Uint8Array, from: unknown) {
        if (from === origin) made = made ? Y.mergeUpdates([made, update]) : update;
      }

      doc.core.ydoc.on('update', capture);
      let result: R;
      try {
        result = doc.core.change(mutate, origin);
      } finally {
        doc.core.ydoc.off('update', capture);
      }

      if (made) {
        this.options.broadcast(ref, made);
        await this.store(doc, made);
      }

      return result;
    });
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

  /** A member left, or a call ended: unload the doc when nothing needs it. */
  release(ref: DocRef): void {
    const key = keyOf(ref);
    const loading = this.docs.get(key);
    if (!loading) return;

    // Wait one turn: a member who is leaving may still be counted while its hook runs.
    void new Promise((resolve) => setTimeout(resolve, 0))
      .then(() => loading)
      .then(
        async (doc) => {
          if (!this.idle(doc)) return;

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

          if (doc.saveTimer) {
            clearTimeout(doc.saveTimer);
            doc.saveTimer = null;
            await this.save(doc);
          }

          // Something may have opened it while the writes and the save ran.
          if (!this.idle(doc) || this.docs.get(key) !== loading) return;

          this.docs.delete(key);
          if (doc.retry) clearTimeout(doc.retry);
          doc.core.destroy();
        },
        () => {},
      );
  }

  private idle(doc: OpenDoc): boolean {
    return doc.busy === 0 && this.options.members(doc.ref) === 0;
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
    const ydoc = new Y.Doc();
    for (const update of updates) Y.applyUpdate(ydoc, update);

    return {
      ref,
      core: new DocCore(def, ydoc),
      writes: Promise.resolve(),
      appends: updates.length,
      bytes: updates.reduce((size, update) => size + update.length, 0),
      saveTimer: null,
      busy: 0,
      unstored: false,
      retry: null,
    };
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
        doc.bytes = state.length;
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

  private scheduleSave(doc: OpenDoc): void {
    if (!this.options.onSave) return;

    if (doc.saveTimer) clearTimeout(doc.saveTimer);
    doc.saveTimer = setTimeout(() => {
      doc.saveTimer = null;
      void this.save(doc);
    }, this.options.saveDelayMs);
  }

  private async save(doc: OpenDoc): Promise<void> {
    try {
      await this.options.onSave?.(doc.ref, doc.core.read());
    } catch (error) {
      this.options.reportError(`onSave failed for '${keyOf(doc.ref)}'`, error);
    }
  }
}
