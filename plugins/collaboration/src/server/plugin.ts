import {
  BINARY_ENVELOPE_LIMIT,
  BINARY_HEADER_LENGTH,
  encodeBase64,
  LiveThingConfigError,
} from '@livething/core';
import { errors, server, t } from '@livething/server';
import { awareness } from '@livething/server/awareness';
import { binary } from '@livething/server/binary';
import { channels } from '@livething/server/channels';
import { clientRequests } from '@livething/server/client-requests';
import { error } from '@livething/server/errors';
import { plugin } from '@livething/server/plugins';
import { scheduled } from '@livething/server/scheduled';
import { tags } from '@livething/server/tags';
import { DocCore } from '~/doc/core.ts';
import { eachPart, joinBytes } from '~/doc/parts.ts';
import {
  docIdProblem,
  FAMILY,
  MAX_DELAY_MS,
  MAX_UPDATE_BYTES,
  OUT_OF_ORDER,
  partBytes,
  PLUGIN_ID,
  ROOM_TEMPLATE,
  roomName,
} from '~/doc/wire.ts';
import { docTypesByName } from '~/schema.ts';
import { checkAwareness, wireAwareness } from '~/server/awareness.ts';
import { DocRegistry } from '~/server/registry.ts';
import {
  deleteVersionInput,
  docDetail,
  labelProblem,
  nothing,
  readVersionInfo,
  saveVersionInput,
  schema,
  updateInfo,
  versionDetail,
} from '~/server/schemas.ts';
import { sqlStorage } from '~/server/storage.ts';
import * as Y from 'yjs';
import type { ConnectionlessContext, HostContext } from '@livething/server';
import type { DocRef } from '~/doc/storage.ts';
import type {
  Access,
  RefusedInfo,
  ServerUpdateInfo,
  SyncInfo,
  UpdateInfo,
  VersionInfo,
  VersionPartInfo,
  WireAwareness,
} from '~/doc/wire.ts';
import type { DocDef, DocNamed, Draft, Snapshot } from '~/schema.ts';
import type { LoadedDoc } from '~/server/registry.ts';
import type { ServerStorage } from '~/server/storage.ts';

/** The doc type is not one the server serves. */
const DocNotFound = error('doc-not-found', docDetail);
/** `access` refused the client. */
const AccessDenied = error('access-denied', docDetail);
/** The doc has no version with that ID. */
const VersionNotFound = error('version-not-found', versionDetail);
/** A message the client sent is not one the plugin can read. */
const InvalidMessage = error(
  'invalid-message',
  schema<{ reason: string }>((value) =>
    typeof (value as { reason?: unknown })?.reason === 'string'
      ? { reason: (value as { reason: string }).reason }
      : { problem: 'expected { reason }' },
  ),
);

/** One member's awareness: room for every lock (32 × 128 bytes), a cursor and the app's fields. */
const MAX_AWARENESS_BYTES = 8 * 1024;

/** The scheduled task that runs a doc's `onSave` once its changes settle. */
const SAVE_TASK = 'save-doc';

/** The key of a doc's editors since its last save, in the plugin's own `ctx.kv`. */
function editorsKey(doc: DocRef): string {
  return `editors:${doc.type}:${doc.id}`;
}

/** Who is opening a doc, for `access`. */
export interface AccessContext {
  /** The user `authenticate` gave the connection, or `null` for none. */
  readonly user: { readonly id: string | null };
  /** The connection's `meta`, from the host's `authenticate`. */
  readonly meta: Readonly<Record<string, unknown>>;
  readonly connection: { readonly id: string };
}

/** What a client may do with a doc: edit it, only read it, or not open it at all. */
export type DocAccess = Access | false;

/** One doc of the app's doc types, by its type name. */
export type DocOf<TDocs extends readonly DocDef[]> = {
  [N in TDocs[number]['name']]: DocRef<N>;
}[TDocs[number]['name']];

/**
 * What `onSave` gets: the doc's type and ID, its content now, and who changed it. Check `type`
 * to narrow `state`.
 */
export type SaveEvent<TDocs extends readonly DocDef[]> = {
  [N in TDocs[number]['name']]: DocRef<N> & {
    readonly state: Snapshot<DocNamed<TDocs, N>['shape']>;
    /**
     * The user IDs of the clients whose changes came since the last `onSave` that ended, in
     * the order each first changed it. Server changes and `onLoad` add nobody, and neither does
     * a client with no user ID. Empty when only those changed the doc.
     */
    readonly editors: readonly string[];
  };
}[TDocs[number]['name']];

/** The parts of the server `onSave` can use: its logger and the adapter's platform object. */
export type SaveContext = Pick<ConnectionlessContext, 'log' | 'platform'>;

/** What `onLoad` gets: the same as `onSave`, its logger and the adapter's platform object. */
export type LoadContext = SaveContext;

/**
 * What `onLoad` gets: a doc as it loads, before anyone reads it. Check `type` to narrow
 * `state` and `change`.
 */
export type LoadEvent<TDocs extends readonly DocDef[]> = {
  [N in TDocs[number]['name']]: DocRef<N> & {
    /** Nothing was ever stored for the doc: it is new, or its storage was cleared. */
    readonly empty: boolean;
    /** The doc as stored. Throws `invalid-change` when that no longer matches the schema. */
    readonly state: Snapshot<DocNamed<TDocs, N>['shape']>;
    /**
     * Edit the doc with the same draft as a server `change()`, and read it back in `state`.
     * The changes are held until `onLoad` ends: then a member already in the room gets them,
     * and they are stored. When `onLoad` throws, none of them is kept. They do not run
     * `onSave`: they copy in what the app already has. Returns what `mutate` returns. Only
     * while `onLoad` runs: later it throws, so edit the doc with a server `change()` then.
     *
     * @throws `invalid-change` when a value fails its schema; the doc stays as it was.
     */
    change<R>(mutate: (draft: Draft<DocNamed<TDocs, N>['shape']>) => R): R;
  };
}[TDocs[number]['name']];

/** The options of the server's {@link collaboration}. */
export interface CollaborationOptions<TDocs extends readonly DocDef[]> {
  /** Every doc type the app has: the same list the client gets. */
  readonly docs: TDocs;
  /**
   * Who may open a doc. Runs when a client opens a doc, and again when it rejoins after a
   * reconnect. Return `'edit'`, `'view'` (the client reads the doc, and the server refuses
   * its changes), or `false` (the client gets `access-denied`). `doc` is typed by the doc
   * types: `{ type: 'task-board', id: string }`.
   */
  access(ctx: AccessContext, doc: DocOf<TDocs>): DocAccess | Promise<DocAccess>;
  /**
   * Runs once a doc's changes settle, `saveDelayMs` after the last one, and when the last
   * member leaves before that. Use it for work that should follow edits but not run on each
   * one: a search index, a webhook, a summary. Check `event.type` to narrow `event.state`.
   * An error it throws is logged.
   */
  onSave?(ctx: SaveContext, event: SaveEvent<TDocs>): void | Promise<void>;
  /**
   * Runs each time a doc loads on this server, before anyone reads it. Use it to fill a new
   * doc from the app's own database, or to bring a stored doc up to date with it: compare
   * `doc.state` with the database, and call `doc.change()`. A throw fails the load and keeps
   * none of its changes, so no client reads a half-filled doc; the next use tries again.
   * Edit the doc only through `doc.change()` here: a server `read()` or `change()` of the same
   * doc waits for the load, which waits for `onLoad`, so neither would ever end.
   */
  onLoad?(ctx: LoadContext, doc: LoadEvent<TDocs>): void | Promise<void>;
  /**
   * How long a doc must stay unchanged before `onSave` runs, in ms.
   * @default 2000
   */
  readonly saveDelayMs?: number;
  /**
   * Where docs and their versions are kept. Edits are live before they are stored; if a
   * write fails, the error is logged, and the doc stays loaded until a later write stores
   * all of it.
   * @default sqlStorage(ctx.sql): tables in the server's own SQL, on Node and Cloudflare.
   */
  readonly storage?: ServerStorage;
  /**
   * The most versions each doc keeps. A save that goes past it deletes the oldest versions of
   * that doc. Default: no limit.
   */
  readonly maxVersions?: number;
}

/** One doc on the server, from `ctx.plugin('livething:collaboration').doc(type, id)`. */
export interface ServerDoc<D extends DocDef> {
  /** The doc's content as a read-only, plain JSON copy. Loads the doc if it is not loaded. */
  read(): Promise<Snapshot<D['shape']>>;
  /**
   * Edit the doc with the same draft as the client's `change()`. Every client that has it
   * open gets the change, and it is stored. A change that writes nothing sends nothing.
   * Resolves with what `mutate` returns.
   *
   * @throws `invalid-change` when a value fails its schema; the doc stays as it was.
   *
   * @example
   * ```ts
   * await collab.doc('task-board', 'launch').change((d) => {
   *   const task = d.tasks.find((t) => t.id === 't_1042')
   *   if (task) task.done = true
   * })
   * ```
   */
  change<R>(mutate: (draft: Draft<D['shape']>) => R): Promise<R>;
  /** The doc's saved versions. */
  readonly versions: ServerVersions<D>;
}

/** A doc's saved versions, for server and admin code. */
export interface ServerVersions<D extends DocDef> {
  /**
   * Save the doc as it is now. When the doc then has more than `maxVersions` versions, the
   * oldest are deleted.
   *
   * @param label 1 to 200 characters, such as `'Nightly'`.
   * @param options `author`: the user shown as the one who saved it. Default `null`.
   * @throws {LiveThingConfigError} For a label that is empty, too long or holds half of an emoji
   * alone.
   */
  save(label: string, options?: { readonly author?: string | null }): Promise<VersionInfo>;
  /** The doc's versions, newest first. */
  list(): Promise<readonly VersionInfo[]>;
  /**
   * One version's content.
   * @throws `version-not-found` when the doc has no version with that ID.
   */
  read(id: string): Promise<Snapshot<D['shape']>>;
  /**
   * Make the doc hold what a version holds, changing only what differs, in one change. Every
   * client that has it open gets it, and list items that are still there keep their IDs.
   * @throws `version-not-found` when the doc has no version with that ID.
   */
  restore(id: string): Promise<void>;
  /**
   * Delete a version. The doc and its other versions stay as they are.
   * @throws `version-not-found` when the doc has no version with that ID.
   */
  delete(id: string): Promise<void>;
}

const REGISTRY = Symbol('livething.collaboration.registry');

/** What `ctx.plugin('livething:collaboration')` and `admin.plugin(...)` give. */
export interface CollaborationApi<TDocs extends readonly DocDef[]> {
  /**
   * One doc of the app, by type and ID, typed by its doc type. Nothing loads until you use it.
   *
   * @throws {LiveThingConfigError} For an unknown type, or an ID that is empty, too long or holds half of an emoji alone
   * (the type, a `:` and the ID are at most 256 characters).
   */
  doc<N extends TDocs[number]['name']>(type: N, id: string): ServerDoc<DocNamed<TDocs, N>>;
}

function checkRef(defs: ReadonlyMap<string, DocDef>, type: unknown, id: unknown): DocRef {
  if (typeof type !== 'string' || !defs.has(type)) {
    throw new LiveThingConfigError(`collaboration: there is no doc type '${String(type)}'`);
  }

  const problem = docIdProblem(type, id);
  if (problem) throw new LiveThingConfigError(problem);

  return { type, id: id as string };
}

function errorData(cause: unknown): Record<string, unknown> {
  return { error: cause instanceof Error ? cause.message : String(cause) };
}

/** An update coming in parts: the pieces so far. */
interface Pending {
  readonly pieces: Uint8Array[];
  readonly count: number;
  /** The update's number, which every part carries and the ack gives back. */
  readonly n: number;
  bytes: number;
  /** Lets the pieces go when no next piece comes in time. */
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * How long the server waits for the next part of an update before it lets the pieces go, so
 * a client that stops halfway can't keep them in memory. Even a slow phone sends a part
 * (at most 256 KiB) in far less.
 */
const PART_TIMEOUT_MS = 60_000;

/** Who sends an update in parts: a connection, to one doc's room. */
interface Sender {
  readonly connection: string;
  readonly room: string;
}

/** Updates coming in parts, by connection and then room. */
class Parts {
  private readonly waiting = new Map<string, Map<string, Pending>>();

  /**
   * Add one piece. Gives the whole update once the last piece came, else `null`. All the
   * pieces one connection has waiting, in every room, are at most `MAX_UPDATE_BYTES`.
   */
  add(
    sender: Sender & { readonly maxParts: number },
    info: UpdateInfo,
    bytes: Uint8Array,
  ): Uint8Array | null {
    const { connection, room } = sender;
    if (!info.part) {
      this.drop(sender);
      // The host's receive limit can be set higher than this.
      if (bytes.length > MAX_UPDATE_BYTES) {
        throw InvalidMessage({
          reason: `an update a client sends can be at most ${MAX_UPDATE_BYTES} bytes`,
        });
      }

      return bytes;
    }

    const rooms = this.waiting.get(connection) ?? new Map<string, Pending>();
    const [index, count] = info.part;
    const pending: Pending | undefined =
      index === 0 ? { pieces: [], count, n: info.n, bytes: 0 } : rooms.get(room);
    if (
      !pending ||
      pending.count !== count ||
      pending.n !== info.n ||
      pending.pieces.length !== index ||
      count > sender.maxParts
    ) {
      this.drop(sender);
      throw InvalidMessage({ reason: 'the parts of an update came out of order' });
    }

    // Checked before the part is copied or a timer holds it, so a refused part keeps nothing.
    let held = pending.bytes + bytes.length;
    for (const [name, each] of rooms) if (name !== room) held += each.bytes;

    if (held > MAX_UPDATE_BYTES) {
      this.drop(sender);
      throw InvalidMessage({
        reason: `the updates a client sends in parts can be at most ${MAX_UPDATE_BYTES} bytes in all`,
      });
    }

    pending.pieces.push(bytes.slice());
    pending.bytes += bytes.length;
    const replaced = rooms.get(room);
    if (replaced && replaced !== pending) clearTimeout(replaced.timer);

    rooms.set(room, pending);
    clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
      if (this.waiting.get(connection)?.get(room) === pending) this.drop(sender);
    }, PART_TIMEOUT_MS);
    // It must not keep a Node server from stopping.
    (pending.timer as { unref?: () => void }).unref?.();
    this.waiting.set(connection, rooms);
    if (index < count - 1) return null;

    this.drop(sender);

    return joinBytes(pending.pieces);
  }

  drop(sender: Sender): void {
    const rooms = this.waiting.get(sender.connection);
    clearTimeout(rooms?.get(sender.room)?.timer);
    rooms?.delete(sender.room);
    if (rooms?.size === 0) this.waiting.delete(sender.connection);
  }
}

/** Anything that holds the host's message limits: every server `ctx`. */
type Limited = Pick<HostContext, 'messageLimits'>;

/** The biggest part this server sends: it fits the host's send limit. */
function sendPartBytes(ctx: Limited): number {
  return partBytes(ctx.messageLimits.sendBytes);
}

/**
 * The biggest part a client may send. It fits an `http()` POST, and the bytes LiveThing lets
 * a binary handler take: the receive limit, less the header and room for a 64 KiB envelope.
 * Under that, it fits the receive limit with its header.
 */
function receivePartBytes(ctx: Limited): number {
  const { receiveBytes, postBytes } = ctx.messageLimits;
  const room = receiveBytes - BINARY_HEADER_LENGTH - BINARY_ENVELOPE_LIMIT;
  return Math.min(partBytes(postBytes ?? receiveBytes), room > 0 ? room : partBytes(receiveBytes));
}

/** Send `update` as one message, or in parts that fit `ctx`'s send limit, one after another. */
function sendInParts(
  ctx: Limited,
  update: Uint8Array,
  send: (bytes: Uint8Array, info: ServerUpdateInfo) => void,
): void {
  eachPart(update, sendPartBytes(ctx), (bytes, part) => send(bytes, part ? { part } : null));
}

/** One `access` tag: the access a connection holds to one doc's room, as `edit:task-board:launch`. */
type AccessTag = `${Access}:${string}`;

/** A handler context's `access` tags, to read which access a connection holds. */
interface AccessTagsContext {
  readonly tags: { ephemeral(group: 'access'): { has(key: AccessTag): boolean } };
}

/** What a running server keeps for the plugin: its loaded docs, the parts in flight, and versions. */
interface PluginState {
  readonly registry: DocRegistry;
  readonly parts: Parts;
  readonly versions: Versions;
}

/** Saving and reading versions, for the handlers and the server API. */
interface Versions {
  save(doc: DocRef, label: string, author: string | null): Promise<VersionInfo>;
  list(doc: DocRef): Promise<readonly VersionInfo[]>;
  /** A version's state: one update that holds the whole doc as it was. */
  state(doc: DocRef, id: string): Promise<Uint8Array>;
  delete(doc: DocRef, id: string): Promise<void>;
}

function notFound(doc: DocRef, id: string) {
  return VersionNotFound({ type: doc.type, id: doc.id, version: id });
}

interface VersionsOptions {
  readonly registry: DocRegistry;
  readonly storage: ServerStorage;
  readonly maxVersions: number | undefined;
  readonly reportError: (message: string, cause: unknown) => void;
}

function versionsOf(options: VersionsOptions): Versions {
  const { registry, storage, maxVersions, reportError } = options;
  return {
    async save(doc, label, author) {
      const version: VersionInfo = {
        id: crypto.randomUUID(),
        label,
        createdAt: Date.now(),
        author,
      };

      await storage.saveVersion(doc, version, await registry.state(doc));
      // The version is stored, so a failed trim is logged, not thrown: the next save trims again.
      if (maxVersions !== undefined) {
        try {
          const extra = (await storage.listVersions(doc)).slice(maxVersions);
          for (const old of extra) await storage.deleteVersion(doc, old.id);
        } catch (cause) {
          reportError(`could not delete old versions of '${doc.type}:${doc.id}'`, cause);
        }
      }

      return version;
    },
    async delete(doc, id) {
      if (!(await storage.deleteVersion(doc, id))) throw notFound(doc, id);
    },
    async list(doc) {
      return storage.listVersions(doc);
    },
    async state(doc, id) {
      const state = await storage.readVersion(doc, id);
      if (!state) throw notFound(doc, id);

      return state;
    },
  };
}

/** A version's state as a Y.Doc. */
function versionDoc(state: Uint8Array): Y.Doc {
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, state);
  return ydoc;
}

/**
 * The Collaboration plugin for the server. Returns a plugin factory: list
 * `HuddleCollaboration()` in the host's capabilities, next to `channels()`.
 *
 * The plugin has one channel family, `docs`, and each doc is one room in it, `<type>:<id>`. The
 * server keeps a loaded copy of each open doc, checks every update against the doc's schema
 * (and undoes a bad one for everyone), stores updates, and unloads a doc when its last
 * member leaves. Server and admin code reach the docs with
 * `ctx.plugin('livething:collaboration')` and `admin.plugin('livething:collaboration')`.
 *
 * @throws {LiveThingConfigError} When a doc type is listed twice, `docs` is empty,
 * `saveDelayMs` is not a whole number from 0 to 2147483647, or `maxVersions` is not a whole
 * number of 1 or more.
 *
 * @example
 * ```ts
 * import { collaboration } from '@livething/plugin-collaboration/server'
 * import { huddleDocs } from '../shared/huddle-docs'
 *
 * export const HuddleCollaboration = collaboration({
 *   docs: huddleDocs,
 *   async access(ctx, doc) {
 *     if (!ctx.user.id || !(await isRoomMember(ctx.user.id, doc.id))) return false
 *
 *     return ctx.meta.role === 'guest' ? 'view' : 'edit'
 *   },
 * })
 * ```
 */
export function collaboration<const TDocs extends readonly DocDef[]>(
  options: CollaborationOptions<TDocs>,
) {
  const defs = docTypesByName(options.docs);
  const saveDelayMs = options.saveDelayMs ?? 2000;
  if (!Number.isInteger(saveDelayMs) || saveDelayMs < 0 || saveDelayMs > MAX_DELAY_MS) {
    throw new LiveThingConfigError(
      `collaboration: \`saveDelayMs\` must be a whole number from 0 to ${MAX_DELAY_MS}`,
    );
  }

  const { maxVersions } = options;
  if (maxVersions !== undefined && (!Number.isInteger(maxVersions) || maxVersions < 1)) {
    throw new LiveThingConfigError(
      'collaboration: `maxVersions` must be a whole number of 1 or more',
    );
  }

  const collaborationServer = server({
    scope: 'plugin',
    capabilities: [
      channels(),
      clientRequests(),
      binary(),
      tags((ephemeral) => [ephemeral('access', t<AccessTag>())]),
      errors([DocNotFound, AccessDenied, VersionNotFound, InvalidMessage]),
      // A due `onSave` is kept in storage, so it runs even after the server restarts, as when
      // Cloudflare evicts a Durable Object.
      scheduled({ [SAVE_TASK]: { data: t<DocRef>() } }),
    ],
    // Store every doc's writes and run the saves that are due, before the server stops.
    async onShutdown(ctx) {
      await stateOf(ctx).registry.flush();
    },
  });

  /** The plugin state of the running server a handler runs on. */
  function stateOf(ctx: unknown): PluginState {
    const api = (ctx as { plugin(id: string): Record<symbol, PluginState> }).plugin(PLUGIN_ID);
    return api[REGISTRY]!;
  }

  function accessKey(access: Access, room: string): AccessTag {
    return `${access}:${room}`;
  }

  function accessOf(ctx: AccessTagsContext, room: string): Access | null {
    const held = ctx.tags.ephemeral('access');
    if (held.has(accessKey('edit', room))) return 'edit';

    return held.has(accessKey('view', room)) ? 'view' : null;
  }

  const docs = collaborationServer.channel([FAMILY, ROOM_TEMPLATE], {
    capabilities: [
      awareness(),
      binary({
        emits: {
          update: t<ServerUpdateInfo>(),
          ack: t<{ n: number }>(),
          refused: t<RefusedInfo>(),
          version: t<VersionPartInfo>(),
        },
      }),
    ],
    awareness: {
      state: wireAwareness,
      maxBytes: MAX_AWARENESS_BYTES,
      check(ctx, state, previous) {
        const room = roomName(ctx.channel.params.type, ctx.channel.params.id);
        const others: WireAwareness[] = [];
        for (const entry of ctx.channel.awareness.list()) {
          if (entry.connectionId !== ctx.connection.id) others.push(entry.state);
        }

        return checkAwareness({
          def: defs.get(ctx.channel.params.type),
          canEdit: accessOf(ctx, room) === 'edit',
          state,
          previous,
          others,
        });
      },
    },
    async check(ctx) {
      const { type, id } = ctx.channel.params;
      // A hand-made client can send any ID: one SQL would store under another key is no doc.
      if (!defs.has(type) || docIdProblem(type, id)) throw DocNotFound({ type, id });

      const access = await options.access(
        {
          user: { id: ctx.user.id || null },
          meta: (ctx.meta ?? {}) as Readonly<Record<string, unknown>>,
          connection: { id: ctx.connection.id },
        },
        { type, id } as DocOf<TDocs>,
      );
      if (access !== 'edit' && access !== 'view') throw AccessDenied({ type, id });

      return access;
    },
    commit(ctx, access) {
      const room = roomName(ctx.channel.params.type, ctx.channel.params.id);
      const held = ctx.tags.ephemeral('access');
      held.remove(accessKey(access === 'edit' ? 'view' : 'edit', room));
      held.add(accessKey(access, room));
    },
    onSessionEnd(ctx) {
      const { type, id } = ctx.channel.params;
      const room = roomName(type, id);
      const held = ctx.tags.ephemeral('access');
      held.remove(accessKey('edit', room));
      held.remove(accessKey('view', room));

      const state = stateOf(ctx);
      state.parts.drop({ connection: ctx.connection.id, room });
      state.registry.release({ type, id });
    },
  });

  const handleSync = docs.binary.request('sync', {
    input: nothing,
    async run(ctx, _info, vector) {
      const { type, id } = ctx.channel.params;
      const access = accessOf(ctx, roomName(type, id));
      if (!access) throw AccessDenied({ type, id });

      try {
        Y.decodeStateVector(vector);
      } catch {
        throw InvalidMessage({ reason: 'the bytes of a sync must be a Yjs state vector' });
      }

      const sync = await stateOf(ctx).registry.sync({ type, id }, vector);
      // The missing update may be too big for one message, so it goes before the answer.
      sendInParts(ctx, sync.missing, (bytes, part) =>
        ctx.channel.binary.send('update', bytes, { info: part }),
      );
      const info: SyncInfo = {
        access,
        vector: encodeBase64(sync.vector),
        partBytes: receivePartBytes(ctx),
      };

      return { info, bytes: new Uint8Array(0) };
    },
  });

  const handleUpdate = docs.binary.on('update', {
    input: updateInfo,
    async run(ctx, info, bytes) {
      const { type, id } = ctx.channel.params;
      const room = roomName(type, id);
      if (accessOf(ctx, room) !== 'edit') {
        ctx.channel.binary.send('refused', undefined, {
          info: { n: info.n, reason: 'this client may only view the doc' },
        });
        return;
      }

      const state = stateOf(ctx);
      // A 32 MiB update in the parts this server asks for, and no more.
      const maxParts = Math.ceil(MAX_UPDATE_BYTES / receivePartBytes(ctx));
      const update = state.parts.add(
        { connection: ctx.connection.id, room, maxParts },
        info,
        bytes,
      );
      if (!update) return;

      let result;
      try {
        result = await state.registry.receive({ type, id }, update, {
          editor: ctx.user.id || null,
          applied(checked) {
            // Send before storing, so every member gets edits in the order the server took them.
            const others = checked.ok ? checked.update : checked.toOthers;
            if (!others) return;

            sendInParts(ctx, others, (piece, part) =>
              ctx.channel.binary.broadcast('update', piece, { info: part }),
            );
          },
        });
      } catch (cause) {
        // Nothing was undone, so the client must not drop its edit: this reason makes it sync
        // again, which sends what the server lacks once the doc loads.
        ctx.channel.binary.send('refused', undefined, {
          info: { n: info.n, reason: OUT_OF_ORDER },
        });
        throw cause;
      }

      if (result.ok) {
        ctx.channel.binary.send('ack', undefined, { info: { n: info.n } });
      } else {
        ctx.channel.binary.send('refused', result.toSender ?? undefined, {
          info: { n: info.n, reason: result.reason },
        });
      }
    },
  });

  /** The doc of the handler's room, after checking the client holds `needs` (or any) access. */
  function docOf(ctx: AccessTagsContext & { channel: { params: DocRef } }, needs?: Access) {
    const { type, id } = ctx.channel.params;
    const access = accessOf(ctx, roomName(type, id));
    if (!access || (needs && access !== needs)) throw AccessDenied({ type, id });

    return { type, id };
  }

  const handleSaveVersion = docs.request('save-version', {
    input: saveVersionInput,
    run: (ctx, input) =>
      stateOf(ctx).versions.save(docOf(ctx, 'edit'), input.label, ctx.user.id || null),
  });

  const handleListVersions = docs.request('list-versions', {
    input: nothing,
    run: async (ctx) => ({ versions: await stateOf(ctx).versions.list(docOf(ctx)) }),
  });

  const handleDeleteVersion = docs.request('delete-version', {
    input: deleteVersionInput,
    async run(ctx, input) {
      await stateOf(ctx).versions.delete(docOf(ctx, 'edit'), input.id);
      return null;
    },
  });

  const handleReadVersion = docs.binary.request('read-version', {
    input: readVersionInfo,
    async run(ctx, info) {
      const state = await stateOf(ctx).versions.state(docOf(ctx), info.id);
      // A version may be too big for one message, so it goes before the answer.
      eachPart(state, sendPartBytes(ctx), (bytes, part) =>
        ctx.channel.binary.send('version', bytes, {
          info: part ? { n: info.n, part } : { n: info.n },
        }),
      );

      return { info: null, bytes: new Uint8Array(0) };
    },
  });

  const handleSaveDoc = collaborationServer.scheduled(SAVE_TASK, {
    async run(ctx, doc) {
      await stateOf(ctx).registry.runDueSave(doc);
    },
  });

  const definition = collaborationServer.assemble({
    handlers: [
      docs,
      handleSync,
      handleUpdate,
      handleSaveVersion,
      handleListVersions,
      handleDeleteVersion,
      handleReadVersion,
      handleSaveDoc,
    ],
    api: (ctx) => {
      function room(doc: DocRef) {
        return ctx.channels.get(FAMILY, roomName(doc.type, doc.id));
      }

      const storage = options.storage ?? sqlStorage(ctx.sql);
      function reportError(message: string, cause: unknown): void {
        ctx.log.error(`[livething] collaboration: ${message}`, errorData(cause));
      }

      const registry = new DocRegistry({
        defs,
        storage,
        saveDelayMs,
        broadcast: (doc, update) =>
          sendInParts(ctx, update, (piece, part) =>
            room(doc).binary.broadcast('update', piece, { info: part }),
          ),
        members: (doc) => room(doc).memberCount(),
        scheduleSave: (doc, time) =>
          ctx.schedule(SAVE_TASK, { time: Math.ceil(time), data: { type: doc.type, id: doc.id } }),
        cancelSave: (doc) => ctx.cancelScheduled(SAVE_TASK, { type: doc.type, id: doc.id }),
        ...(options.onSave
          ? {
              onSave: (doc: DocRef, saved: unknown, editors: readonly string[]) =>
                options.onSave!({ log: ctx.log, platform: ctx.platform }, {
                  type: doc.type,
                  id: doc.id,
                  state: saved,
                  editors,
                } as SaveEvent<TDocs>),
              // In the plugin's own key-value store, so a save after a restart still names them.
              editors: {
                async load(doc: DocRef) {
                  const kept = await ctx.kv.get(editorsKey(doc));
                  return Array.isArray(kept)
                    ? kept.filter((editor): editor is string => typeof editor === 'string')
                    : [];
                },
                store: (doc: DocRef, editors: readonly string[]) =>
                  editors.length > 0
                    ? ctx.kv.set(editorsKey(doc), editors)
                    : ctx.kv.delete(editorsKey(doc)),
              },
            }
          : {}),
        ...(options.onLoad
          ? {
              onLoad: (doc: DocRef, loaded: LoadedDoc) =>
                options.onLoad!({ log: ctx.log, platform: ctx.platform }, {
                  type: doc.type,
                  id: doc.id,
                  empty: loaded.empty,
                  // Read when used: a doc the schema refuses still loads for a `change()`.
                  get state() {
                    return loaded.state();
                  },
                  change: loaded.change,
                } as LoadEvent<TDocs>),
            }
          : {}),
        reportError,
      });
      const state: PluginState = {
        parts: new Parts(),
        registry,
        versions: versionsOf({ registry, storage, maxVersions, reportError }),
      };

      const api: CollaborationApi<TDocs> = {
        doc(type, id) {
          const ref = checkRef(defs, type, id);
          const versions: ServerVersions<DocDef> = {
            async save(label, saveOptions) {
              const problem = labelProblem(label);
              if (problem) throw new LiveThingConfigError(`collaboration: ${problem}`);

              return state.versions.save(ref, label, saveOptions?.author ?? null);
            },
            list: () => state.versions.list(ref),
            async read(versionId) {
              const core = new DocCore(
                defs.get(ref.type)!,
                versionDoc(await state.versions.state(ref, versionId)),
              );
              try {
                return core.read();
              } finally {
                core.destroy();
              }
            },
            async restore(versionId) {
              const version = versionDoc(await state.versions.state(ref, versionId));
              await registry.restore(ref, version);
            },
            delete: (versionId) => state.versions.delete(ref, versionId),
          };

          return {
            read: () => registry.read(ref),
            change: (mutate) => registry.change(ref, mutate as never),
            versions,
          } as ServerDoc<DocNamed<TDocs, typeof type>>;
        },
      };

      Object.defineProperty(api, REGISTRY, { value: state });

      return api;
    },
  });

  return plugin(PLUGIN_ID, { definition });
}
