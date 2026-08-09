import { validateValue } from '~/_engine/compile/utils.ts';
import { forEachIsolated } from '~/_engine/runtime/isolation.ts';
import {
  addConnectionTag,
  connectionTagRefs,
  makeTagRef,
  removeConnectionTag,
  tagGroupIndexKey,
  tagRefIndexKey,
} from '~/_engine/runtime/tag-index.ts';
import { deleteTag, insertTag } from '~/tags/storage.ts';
import type { TagKey } from '~/_engine/runtime/tag-index.ts';
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

  getStorage(): { sql: Pick<SQLProvider, 'exec'> };
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

  const persistsDurably = runtime.persistenceEnabled && connection.userId.length > 0;

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
        insertTag(runtime.getStorage().sql, { userId: connection.userId, group, key });
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
        deleteTag(runtime.getStorage().sql, { userId: connection.userId, group, key });
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
      return [...keys].map((key) => makeTagRef(kind, group, key));
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
      return connectionTagRefs(connection);
    },
  };
}
