import { validateValue } from '~/_engine/compile/utils.ts';
import { forEachIsolated } from '~/_engine/runtime/isolation.ts';
import { deleteTag, insertTag } from '~/tags/storage.ts';
import type * as EngineRuntimeTypes from '~/_engine/runtime/types.ts';
import type { ConnectionInfo, SQLProvider, TagRef } from '~/context.ts';
import type { TagGroupHandle, TagKind, TagRefHandle, TagsApi } from '~/tags/types.ts';
import type { Validator } from '~/types.ts';

type RuntimeConnection = EngineRuntimeTypes.RuntimeConnection;

/**
 * Dependency bag the tag surface needs from the engine. Built once per
 * connection context.
 */
export interface TagsRuntime {
  tagMembers: Map<string, Set<RuntimeConnection>>;

  isTagGroupDeclared(kind: TagKind, group: string): boolean;

  /** The runtime validator for a tag group, or `undefined` when it has none. */
  getTagGroupSchema(kind: TagKind, group: string): Validator | undefined;

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
    `[wskit] tag group '${group}' is not declared under tags (${kind}). Add it to your contract's tags: builder or check for a typo.`,
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

export interface TagKey {
  kind: TagKind;

  group: string;

  key: string;
}

/**
 * Tag a connection and update the member index. Returns `false` when the
 * connection already held the tag.
 */
export function addConnectionTag(
  tagMembers: Map<string, Set<RuntimeConnection>>,
  connection: RuntimeConnection,
  tag: TagKey,
): boolean {
  const { kind, group, key } = tag;
  // An empty key addresses no bucket. Reject it here so every path — the
  // group handle, onUpgrade-supplied tags, and rejoin — is uniform and no
  // phantom "" tag can be created for ref('').send() to fan out to.
  if (key.length === 0) return false;
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
  tag: TagKey,
): boolean {
  const { kind, group, key } = tag;
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
  tag: TagKey,
): TagRefHandle {
  const { kind, group, key } = tag;
  return {
    __wskit: 'tag-ref',
    kind,
    group,
    key,
    send(event: string, payload: unknown) {
      const members = runtime.tagMembers.get(tagRefIndexKey(kind, group, key));
      if (!members) return;
      forEachIsolated(members, (target) => runtime.sendThroughPipeline(target, event, payload), {
        context: `tag ref send '${kind}:${group}/${key}' event="${event}"`,
      });
    },
    connections() {
      const members = runtime.tagMembers.get(tagRefIndexKey(kind, group, key));
      if (!members) return [];
      return [...members].map((target) => runtime.toConnectionInfo(target));
    },
    count(): number {
      return runtime.tagMembers.get(tagRefIndexKey(kind, group, key))?.size ?? 0;
    },
    has(ref) {
      const members = runtime.tagMembers.get(tagRefIndexKey(kind, group, key));
      if (!members) return false;
      for (const target of members) {
        if (target.id === ref.id) return true;
      }
      return false;
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

export interface TagGroupRef {
  kind: TagKind;
  group: string;
}

/**
 * Build the group-handle surface for one `(kind, group)`. Validates the
 * group is declared; throws if not.
 */
export function buildGroupHandle(
  runtime: TagsRuntime,
  connection: RuntimeConnection,
  groupRef: TagGroupRef,
): TagGroupHandle {
  const { kind, group } = groupRef;
  assertGroupDeclared(runtime, kind, group);

  // True when a persistent-tag change also needs a durable SQL write.
  const persistsDurably = runtime.persistenceEnabled && connection.identity.length > 0;

  return {
    __wskit: 'group-handle',
    kind,
    group,

    add(key: string) {
      // An empty key addresses no bucket. Guard it as a no-op so an untyped
      // t<>() group can't create a phantom "" tag that ref('').send() would
      // then fan out to. Runs before schema validation so the no-op is
      // uniform regardless of how the group was declared.
      if (key.length === 0) return;
      // Validate the value when the group declared a schema. A t<>() group has
      // no schema and skips this. Throws ValidationFailed on a bad value before
      // any state changes.
      const schema = runtime.getTagGroupSchema(kind, group);
      if (schema) validateValue(schema, key, `tag ${kind}:${group}`);

      if (kind === 'ephemeral') {
        if (!addConnectionTag(runtime.tagMembers, connection, { kind, group, key })) return;
        runtime.persistAttachment(connection);
        return;
      }
      // Skip if already held (matches addConnectionTag's idempotency).
      if (readBag(connection, kind).get(group)?.has(key)) return;
      // Durable write before the live mutation, so a failed SQL write cannot
      // leave the tag live with nothing saved.
      if (persistsDurably) {
        insertTag(runtime.requireStorage().sql, { identity: connection.identity, group, key });
      }
      addConnectionTag(runtime.tagMembers, connection, { kind, group, key });
    },

    remove(key: string) {
      // Symmetry with add(): an empty key was never stored, so removing it is
      // a no-op (and must not attempt a durable delete).
      if (key.length === 0) return;
      if (kind === 'ephemeral') {
        if (!removeConnectionTag(runtime.tagMembers, connection, { kind, group, key })) return;
        runtime.persistAttachment(connection);
        return;
      }
      // Skip if not held (matches removeConnectionTag's guard).
      if (!readBag(connection, kind).get(group)?.has(key)) return;
      // Durable delete before the live mutation, for the same reason as add().
      if (persistsDurably) {
        deleteTag(runtime.requireStorage().sql, { identity: connection.identity, group, key });
      }
      removeConnectionTag(runtime.tagMembers, connection, { kind, group, key });
    },

    has(key: string): boolean {
      return readBag(connection, kind).get(group)?.has(key) ?? false;
    },

    send(event: string, payload: unknown) {
      const members = runtime.tagMembers.get(tagGroupIndexKey(kind, group));
      if (!members) return;
      forEachIsolated(members, (target) => runtime.sendThroughPipeline(target, event, payload), {
        context: `tag group send '${kind}:${group}' event="${event}"`,
      });
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
      return makeRefHandle(runtime, { kind, group, key });
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
      return buildGroupHandle(runtime, connection, { kind: 'ephemeral', group });
    },
    persistent(group: string) {
      return buildGroupHandle(runtime, connection, { kind: 'persistent', group });
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
