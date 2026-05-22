import { deleteTag, insertTag } from '~/tags/storage.ts';
import type * as EngineRuntimeTypes from '~/_engine/runtime/types.ts';
import type { ConnectionInfo, SQLProvider, TagRef } from '~/context.ts';
import type { GroupHandle, TagKind, TagRefHandle, TagsApi } from '~/tags/types.ts';

type RuntimeConnection = EngineRuntimeTypes.RuntimeConnection;

/**
 * Dependency bag the tag surface needs from the engine. Built once per
 * connection context.
 */
export interface TagsRuntime {
  tagMembers: Map<string, Set<RuntimeConnection>>;
  isTagGroupDeclared(kind: TagKind, group: string): boolean;
  toConnectionInfo(connection: RuntimeConnection): ConnectionInfo<Record<string, unknown>>;
  sendThroughPipeline(connection: RuntimeConnection, event: string, payload: unknown): void;
  persistAttachment(connection: RuntimeConnection): void;
  persistenceEnabled: boolean;
  requireStorage(): { sql: Pick<SQLProvider, 'exec'> };
}

function assertGroupDeclared(
  runtime: Pick<TagsRuntime, 'isTagGroupDeclared'>,
  kind: TagKind,
  group: string,
): void {
  if (runtime.isTagGroupDeclared(kind, group)) return;
  throw new Error(
    `[wskit] tag group '${group}' is not declared under tagGroups.${kind}. Add it to your contract's tagGroups config or check for a typo.`,
  );
}

function readBag(connection: RuntimeConnection, kind: TagKind): Map<string, Set<string>> {
  return connection.tags[kind];
}

function getOrCreateSet(bag: Map<string, Set<string>>, group: string): Set<string> {
  let set = bag.get(group);
  if (!set) {
    set = new Set<string>();
    bag.set(group, set);
  }
  return set;
}

function tagGroupIndexKey(kind: TagKind, group: string): string {
  return JSON.stringify([kind, group]);
}

function tagRefIndexKey(kind: TagKind, group: string, key: string): string {
  return JSON.stringify([kind, group, key]);
}

function addToTagIndex(
  tagMembers: Map<string, Set<RuntimeConnection>>,
  indexKey: string,
  connection: RuntimeConnection,
): void {
  let members = tagMembers.get(indexKey);
  if (!members) {
    members = new Set();
    tagMembers.set(indexKey, members);
  }
  members.add(connection);
}

function removeFromTagIndex(
  tagMembers: Map<string, Set<RuntimeConnection>>,
  indexKey: string,
  connection: RuntimeConnection,
): void {
  const members = tagMembers.get(indexKey);
  if (!members) return;
  members.delete(connection);
  if (members.size === 0) tagMembers.delete(indexKey);
}

/**
 * Tag a connection and update the member index. Returns `false` when the
 * connection already held the tag.
 */
export function addConnectionTag(
  tagMembers: Map<string, Set<RuntimeConnection>>,
  connection: RuntimeConnection,
  kind: TagKind,
  group: string,
  key: string,
): boolean {
  const set = getOrCreateSet(connection.tags[kind], group);
  if (set.has(key)) return false;
  set.add(key);
  addToTagIndex(tagMembers, tagRefIndexKey(kind, group, key), connection);
  addToTagIndex(tagMembers, tagGroupIndexKey(kind, group), connection);
  return true;
}

/**
 * Remove a tag from a connection and update the member index. Returns `false`
 * when the connection did not hold the tag.
 */
export function removeConnectionTag(
  tagMembers: Map<string, Set<RuntimeConnection>>,
  connection: RuntimeConnection,
  kind: TagKind,
  group: string,
  key: string,
): boolean {
  const bag = connection.tags[kind];
  const set = bag.get(group);
  if (!set || !set.delete(key)) return false;
  removeFromTagIndex(tagMembers, tagRefIndexKey(kind, group, key), connection);
  if (set.size === 0) {
    bag.delete(group);
    removeFromTagIndex(tagMembers, tagGroupIndexKey(kind, group), connection);
  }
  return true;
}

/** Drop a closing connection from every tag-index entry it appears in. */
export function removeConnectionFromTagIndex(
  tagMembers: Map<string, Set<RuntimeConnection>>,
  connection: RuntimeConnection,
): void {
  for (const kind of ['ephemeral', 'persistent'] as const) {
    for (const [group, keys] of connection.tags[kind]) {
      removeFromTagIndex(tagMembers, tagGroupIndexKey(kind, group), connection);
      for (const key of keys) {
        removeFromTagIndex(tagMembers, tagRefIndexKey(kind, group, key), connection);
      }
    }
  }
}

function makeRef(kind: TagKind, group: string, key: string): TagRef {
  return { __wskit: 'tag-ref', kind, group, key };
}

function makeRefHandle(
  runtime: Pick<TagsRuntime, 'tagMembers' | 'toConnectionInfo' | 'sendThroughPipeline'>,
  kind: TagKind,
  group: string,
  key: string,
): TagRefHandle {
  return {
    __wskit: 'tag-ref',
    kind,
    group,
    key,
    send(event: string, payload: unknown) {
      const members = runtime.tagMembers.get(tagRefIndexKey(kind, group, key));
      if (!members) return;
      for (const target of members) {
        runtime.sendThroughPipeline(target, event, payload);
      }
    },
    connections() {
      const members = runtime.tagMembers.get(tagRefIndexKey(kind, group, key));
      if (!members) return [];
      return [...members].map((target) => runtime.toConnectionInfo(target));
    },
    count(): number {
      return runtime.tagMembers.get(tagRefIndexKey(kind, group, key))?.size ?? 0;
    },
  };
}

function listConnectionTags(connection: RuntimeConnection): TagRef[] {
  const refs: TagRef[] = [];
  for (const [group, keys] of connection.tags.ephemeral) {
    for (const key of keys) refs.push(makeRef('ephemeral', group, key));
  }
  for (const [group, keys] of connection.tags.persistent) {
    for (const key of keys) refs.push(makeRef('persistent', group, key));
  }
  return refs;
}

/**
 * Build the group-handle surface for one `(kind, group)`. Validates the
 * group is declared; throws if not.
 */
export function buildGroupHandle(
  runtime: TagsRuntime,
  connection: RuntimeConnection,
  kind: TagKind,
  group: string,
): GroupHandle {
  assertGroupDeclared(runtime, kind, group);

  return {
    __wskit: 'group-handle',
    kind,
    group,

    add(key: string) {
      if (!addConnectionTag(runtime.tagMembers, connection, kind, group, key)) return;
      if (kind === 'ephemeral') {
        runtime.persistAttachment(connection);
        return;
      }
      if (runtime.persistenceEnabled && connection.identity) {
        insertTag(runtime.requireStorage().sql, connection.identity, group, key);
      }
    },

    remove(key: string) {
      if (!removeConnectionTag(runtime.tagMembers, connection, kind, group, key)) return;
      if (kind === 'ephemeral') {
        runtime.persistAttachment(connection);
        return;
      }
      if (runtime.persistenceEnabled && connection.identity) {
        deleteTag(runtime.requireStorage().sql, connection.identity, group, key);
      }
    },

    has(key: string): boolean {
      return readBag(connection, kind).get(group)?.has(key) ?? false;
    },

    send(event: string, payload: unknown) {
      const members = runtime.tagMembers.get(tagGroupIndexKey(kind, group));
      if (!members) return;
      for (const target of members) {
        runtime.sendThroughPipeline(target, event, payload);
      }
    },

    connections() {
      const members = runtime.tagMembers.get(tagGroupIndexKey(kind, group));
      if (!members) return [];
      return [...members].map((target) => runtime.toConnectionInfo(target));
    },

    count(): number {
      return runtime.tagMembers.get(tagGroupIndexKey(kind, group))?.size ?? 0;
    },

    keys(): readonly string[] {
      const members = runtime.tagMembers.get(tagGroupIndexKey(kind, group));
      if (!members) return [];
      const out = new Set<string>();
      for (const target of members) {
        const set = readBag(target, kind).get(group);
        if (set) for (const key of set) out.add(key);
      }
      return [...out];
    },

    ref(key: string): TagRefHandle {
      return makeRefHandle(runtime, kind, group, key);
    },

    list(): readonly TagRef[] {
      const keys = readBag(connection, kind).get(group);
      if (!keys || keys.size === 0) return [];
      return [...keys].map((key) => makeRef(kind, group, key));
    },
  };
}

/**
 * Build `ctx.tags` — the typed entry point for the tag API.
 */
export function buildTagsApi(runtime: TagsRuntime, connection: RuntimeConnection): TagsApi {
  return {
    ephemeral(group: string) {
      return buildGroupHandle(runtime, connection, 'ephemeral', group);
    },
    persistent(group: string) {
      return buildGroupHandle(runtime, connection, 'persistent', group);
    },
    list(): readonly TagRef[] {
      return listConnectionTags(connection);
    },
  };
}

/** Build the public-facing TagRef list for `ConnectionInfo.tags`. */
export function buildConnectionTagRefs(connection: RuntimeConnection): readonly TagRef[] {
  return listConnectionTags(connection);
}
