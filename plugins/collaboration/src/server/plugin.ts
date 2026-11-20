import { encodeBase64, LiveThingConfigError } from '@livething/core';
import { errors, server, t } from '@livething/server';
import { awareness } from '@livething/server/awareness';
import { binary } from '@livething/server/binary';
import { channels } from '@livething/server/channels';
import { clientRequests } from '@livething/server/client-requests';
import { error } from '@livething/server/errors';
import { plugin } from '@livething/server/plugins';
import { tags } from '@livething/server/tags';
import { DocCore } from '~/doc/core.ts';
import { eachPart, joinBytes } from '~/doc/parts.ts';
import { FAMILY, MAX_PARTS, PLUGIN_ID, ROOM_TEMPLATE, roomName } from '~/doc/wire.ts';
import { checkAwareness, wireAwareness } from '~/server/awareness.ts';
import { DocRegistry } from '~/server/registry.ts';
import {
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
import type { ConnectionlessContext } from '@livething/server';
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

/** The most bytes of one update, all its parts together. */
const MAX_UPDATE_BYTES = 32 * 1024 * 1024;
const MAX_ROOM_NAME = 256;
/** One member's awareness: room for every lock (32 × 128 bytes), a cursor and the app's fields. */
const MAX_AWARENESS_BYTES = 8 * 1024;

/** Who is opening a doc, for `access`. */
export interface AccessContext {
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

/** What `onSave` gets: the doc's type and ID, and its content now. Check `type` to narrow `state`. */
export type SaveEvent<TDocs extends readonly DocDef[]> = {
  [N in TDocs[number]['name']]: DocRef<N> & {
    readonly state: Snapshot<DocNamed<TDocs, N>['shape']>;
  };
}[TDocs[number]['name']];

/** The parts of the server `onSave` can use: its logger and the adapter's platform object. */
export type SaveContext = Pick<ConnectionlessContext, 'log' | 'platform'>;

export interface CollaborationOptions<TDocs extends readonly DocDef[]> {
  /** Every doc type the app has: the same list the client gets. */
  readonly docs: TDocs;
  /**
   * Runs when a client opens a doc, and again when it rejoins after a reconnect. Return
   * `'edit'`, `'view'`, or `false` to refuse.
   */
  access(ctx: AccessContext, doc: DocOf<TDocs>): DocAccess | Promise<DocAccess>;
  /** Runs after a doc's changes settle, `saveDelayMs` after the last one. */
  onSave?(ctx: SaveContext, event: SaveEvent<TDocs>): void | Promise<void>;
  /** How long a doc must stay unchanged before `onSave` runs, in ms. Default 2000. */
  readonly saveDelayMs?: number;
  /** Where docs and their versions are kept. Default: tables in the server's own SQL storage. */
  readonly storage?: ServerStorage;
}

/** One doc on the server, for server and admin code. */
export interface ServerDoc<D extends DocDef> {
  /** The doc's content as a read-only, plain JSON copy. */
  read(): Promise<Snapshot<D['shape']>>;
  /** Edit the doc. Every client that has it open gets the change. */
  change<R>(mutate: (draft: Draft<D['shape']>) => R): Promise<R>;
  readonly versions: ServerVersions<D>;
}

/** A doc's saved versions, for server and admin code. */
export interface ServerVersions<D extends DocDef> {
  /** Save the doc as it is now. `author` is the user shown as the one who saved it. Default `null`. */
  save(label: string, options?: { readonly author?: string | null }): Promise<VersionInfo>;
  /** The doc's versions, newest first. */
  list(): Promise<readonly VersionInfo[]>;
  /** One version's content. */
  read(id: string): Promise<Snapshot<D['shape']>>;
  /** Make the doc hold what a version holds, in one change. Every client that has it open gets it. */
  restore(id: string): Promise<void>;
}

const REGISTRY = Symbol('livething.collaboration.registry');

/** What `ctx.plugin('livething:collaboration')` and `admin.plugin(...)` give. */
export interface CollaborationApi<TDocs extends readonly DocDef[]> {
  /** One doc of the app, by type and ID. */
  doc<N extends TDocs[number]['name']>(type: N, id: string): ServerDoc<DocNamed<TDocs, N>>;
}

function checkRef(defs: ReadonlyMap<string, DocDef>, type: unknown, id: unknown): DocRef {
  if (typeof type !== 'string' || !defs.has(type)) {
    throw new LiveThingConfigError(`collaboration: there is no doc type '${String(type)}'`);
  }

  if (typeof id !== 'string' || id === '' || roomName(type, id).length > MAX_ROOM_NAME) {
    throw new LiveThingConfigError(
      `collaboration: a doc ID must be a string of 1 to ${MAX_ROOM_NAME - type.length - 1} characters`,
    );
  }

  return { type, id };
}

function errorData(cause: unknown): Record<string, unknown> {
  return { error: cause instanceof Error ? cause.message : String(cause) };
}

/** An update coming in parts: the pieces so far. */
interface Pending {
  readonly pieces: Uint8Array[];
  readonly count: number;
  bytes: number;
}

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
  add(sender: Sender, info: UpdateInfo, bytes: Uint8Array): Uint8Array | null {
    const { connection, room } = sender;
    if (!info.part) {
      this.drop(sender);
      return bytes;
    }

    const rooms = this.waiting.get(connection) ?? new Map<string, Pending>();
    const [index, count] = info.part;
    const pending: Pending | undefined =
      index === 0 ? { pieces: [], count, bytes: 0 } : rooms.get(room);
    if (
      !pending ||
      pending.count !== count ||
      pending.pieces.length !== index ||
      count > MAX_PARTS
    ) {
      this.drop(sender);
      throw InvalidMessage({ reason: 'the parts of an update came out of order' });
    }

    pending.pieces.push(bytes.slice());
    pending.bytes += bytes.length;
    rooms.set(room, pending);
    let held = 0;
    for (const each of rooms.values()) held += each.bytes;

    if (held > MAX_UPDATE_BYTES) {
      this.drop(sender);
      throw InvalidMessage({
        reason: `the updates a client sends in parts can be at most ${MAX_UPDATE_BYTES} bytes in all`,
      });
    }

    this.waiting.set(connection, rooms);
    if (index < count - 1) return null;

    this.drop(sender);

    return Y.mergeUpdates([joinBytes(pending.pieces)]);
  }

  drop(sender: Sender): void {
    const rooms = this.waiting.get(sender.connection);
    rooms?.delete(sender.room);
    if (rooms?.size === 0) this.waiting.delete(sender.connection);
  }
}

/** Send `update` as one message, or in parts, one after another. */
function sendInParts(
  update: Uint8Array,
  send: (bytes: Uint8Array, info: ServerUpdateInfo) => void,
): void {
  eachPart(update, (bytes, part) => send(bytes, part ? { part } : null));
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
}

function versionsOf(registry: DocRegistry, storage: ServerStorage): Versions {
  return {
    async save(doc, label, author) {
      const version: VersionInfo = {
        id: crypto.randomUUID(),
        label,
        createdAt: Date.now(),
        author,
      };

      await storage.saveVersion(doc, version, await registry.state(doc));

      return version;
    },
    async list(doc) {
      return storage.listVersions(doc);
    },
    async state(doc, id) {
      const state = await storage.readVersion(doc, id);
      if (!state) throw VersionNotFound({ type: doc.type, id: doc.id, version: id });

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
 * `HuddleCollaboration()` in the host's capabilities.
 *
 * @example
 * ```ts
 * export const HuddleCollaboration = collaboration({
 *   docs: huddleDocs,
 *   async access(ctx, doc) {
 *     if (!(await isRoomMember(ctx.user.id, doc.id))) return false
 *     return ctx.meta.role === 'guest' ? 'view' : 'edit'
 *   },
 * })
 * ```
 */
export function collaboration<const TDocs extends readonly DocDef[]>(
  options: CollaborationOptions<TDocs>,
) {
  const defs = new Map<string, DocDef>();
  for (const def of options.docs) {
    if (defs.has(def.name)) {
      throw new LiveThingConfigError(`collaboration: the doc type '${def.name}' is listed twice`);
    }

    defs.set(def.name, def);
  }

  if (defs.size === 0) {
    throw new LiveThingConfigError('collaboration: list at least one doc type in `docs`');
  }

  const saveDelayMs = options.saveDelayMs ?? 2000;
  if (!Number.isInteger(saveDelayMs) || saveDelayMs < 0) {
    throw new LiveThingConfigError(
      'collaboration: `saveDelayMs` must be a whole number of 0 or more',
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
    ],
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
      if (!defs.has(type)) throw DocNotFound({ type, id });

      const access = await options.access(
        {
          user: { id: ctx.user.id ?? null },
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
      sendInParts(sync.missing, (bytes, part) =>
        ctx.channel.binary.send('update', bytes, { info: part }),
      );
      const info: SyncInfo = { access, vector: encodeBase64(sync.vector) };

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
      const update = state.parts.add({ connection: ctx.connection.id, room }, info, bytes);
      if (!update) return;

      let result;
      try {
        result = await state.registry.receive({ type, id }, update, (checked) => {
          // Send before storing, so every member gets edits in the order the server took them.
          const others = checked.ok ? checked.update : checked.toOthers;
          if (!others) return;

          sendInParts(others, (piece, part) =>
            ctx.channel.binary.broadcast('update', piece, { info: part }),
          );
        });
      } catch (cause) {
        ctx.channel.binary.send('refused', undefined, {
          info: { n: info.n, reason: 'the server could not open the doc' },
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
      stateOf(ctx).versions.save(docOf(ctx, 'edit'), input.label, ctx.user.id ?? null),
  });

  const handleListVersions = docs.request('list-versions', {
    input: nothing,
    run: async (ctx) => ({ versions: await stateOf(ctx).versions.list(docOf(ctx)) }),
  });

  const handleReadVersion = docs.binary.request('read-version', {
    input: readVersionInfo,
    async run(ctx, info) {
      const state = await stateOf(ctx).versions.state(docOf(ctx), info.id);
      // A version may be too big for one message, so it goes before the answer.
      eachPart(state, (bytes, part) =>
        ctx.channel.binary.send('version', bytes, {
          info: part ? { n: info.n, part } : { n: info.n },
        }),
      );

      return { info: null, bytes: new Uint8Array(0) };
    },
  });

  const definition = collaborationServer.assemble({
    handlers: [
      docs,
      handleSync,
      handleUpdate,
      handleSaveVersion,
      handleListVersions,
      handleReadVersion,
    ],
    api: (ctx) => {
      function room(doc: DocRef) {
        return ctx.channels.get(FAMILY, roomName(doc.type, doc.id));
      }

      const storage = options.storage ?? sqlStorage(ctx.sql);
      const registry = new DocRegistry({
        defs,
        storage,
        saveDelayMs,
        broadcast: (doc, update) =>
          sendInParts(update, (piece, part) =>
            room(doc).binary.broadcast('update', piece, { info: part }),
          ),
        members: (doc) => room(doc).memberCount(),
        ...(options.onSave
          ? {
              onSave: (doc: DocRef, saved: unknown) =>
                options.onSave!({ log: ctx.log, platform: ctx.platform }, {
                  type: doc.type,
                  id: doc.id,
                  state: saved,
                } as SaveEvent<TDocs>),
            }
          : {}),
        reportError: (message, cause) =>
          ctx.log.error(`[livething] collaboration: ${message}`, errorData(cause)),
      });
      const state: PluginState = {
        parts: new Parts(),
        registry,
        versions: versionsOf(registry, storage),
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
