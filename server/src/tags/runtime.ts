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
  connections: ReadonlyMap<string, RuntimeConnection>;
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
    `[wskit] tag group '${group}' is not declared under .tagGroups('${kind}', ...). Register it on the builder or check for a typo.`,
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

function makeRef(kind: TagKind, group: string, key: string): TagRef {
  return { __wskit: 'tag-ref', kind, group, key };
}

function makeRefHandle(
  runtime: Pick<TagsRuntime, 'connections' | 'toConnectionInfo' | 'sendThroughPipeline'>,
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
      for (const target of runtime.connections.values()) {
        if (target.tags[kind].get(group)?.has(key)) {
          runtime.sendThroughPipeline(target, event, payload);
        }
      }
    },
    connections() {
      const out: ConnectionInfo<Record<string, unknown>>[] = [];
      for (const target of runtime.connections.values()) {
        if (target.tags[kind].get(group)?.has(key)) {
          out.push(runtime.toConnectionInfo(target));
        }
      }
      return out;
    },
    count(): number {
      let total = 0;
      for (const target of runtime.connections.values()) {
        if (target.tags[kind].get(group)?.has(key)) total++;
      }
      return total;
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
      const set = getOrCreateSet(readBag(connection, kind), group);
      if (set.has(key)) return;
      set.add(key);
      if (kind === 'ephemeral') {
        runtime.persistAttachment(connection);
        return;
      }
      if (runtime.persistenceEnabled && connection.identity) {
        insertTag(runtime.requireStorage().sql, connection.identity, group, key);
      }
    },

    remove(key: string) {
      const set = readBag(connection, kind).get(group);
      if (!set || !set.delete(key)) return;
      if (set.size === 0) readBag(connection, kind).delete(group);
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
      for (const target of runtime.connections.values()) {
        if ((readBag(target, kind).get(group)?.size ?? 0) === 0) continue;
        runtime.sendThroughPipeline(target, event, payload);
      }
    },

    connections() {
      const out: ConnectionInfo<Record<string, unknown>>[] = [];
      for (const target of runtime.connections.values()) {
        if ((readBag(target, kind).get(group)?.size ?? 0) === 0) continue;
        out.push(runtime.toConnectionInfo(target));
      }
      return out;
    },

    count(): number {
      let total = 0;
      for (const target of runtime.connections.values()) {
        if ((readBag(target, kind).get(group)?.size ?? 0) > 0) total++;
      }
      return total;
    },

    keys(): readonly string[] {
      const out = new Set<string>();
      for (const target of runtime.connections.values()) {
        const set = readBag(target, kind).get(group);
        if (!set) continue;
        for (const key of set) out.add(key);
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
