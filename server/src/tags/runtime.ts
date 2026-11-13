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
import type { AddBinarySenders } from '~/_engine/runtime/feature-slots.ts';
import type { TagKey } from '~/_engine/runtime/tag-index.ts';
import type * as EngineRuntimeTypes from '~/_engine/runtime/types.ts';
import type { ConnectionInfo, Logger, SQLProvider, TagRef } from '~/context.ts';
import type { OutgoingTarget } from '~/intercept/intercept.ts';
import type { TagGroupHandle, TagKind, TagRefHandle, TagsApi } from '~/tags/types.ts';
import type { Validator } from '~/types.ts';

type RuntimeConnection = EngineRuntimeTypes.RuntimeConnection;

/**
 * Dependency bag the tag surface needs from the engine. Built once per
 * connection context.
 */
export interface TagsRuntime {
  tagMembers: Map<string, Set<RuntimeConnection>>;

  /** Live connections by user id. A persistent tag belongs to the user, so it changes on all of them. */
  usersByKey: Map<string, Set<RuntimeConnection>>;

  isTagGroupDeclared(kind: TagKind, group: string): boolean;

  /** The runtime validator for a tag group, or `undefined` when it has none. */
  getTagGroupSchema(kind: TagKind, group: string): Validator | undefined;

  toConnectionInfo(connection: RuntimeConnection): ConnectionInfo<Record<string, unknown>>;

  /** Send one event to the given connections as one shared frame. Returns how many got it. */
  sendToConnections(
    connections: Iterable<RuntimeConnection>,
    opts: { event: string; payload: unknown; target: OutgoingTarget },
  ): number;

  persistAttachment(connection: RuntimeConnection): void;

  /** The app's logger, for a broadcast that fails before it reaches anyone. */
  logger: Pick<Logger, 'error'>;

  getStorage(): { sql: Pick<SQLProvider, 'exec'> };

  /** Whether `purgeUser` is running for this user. A persistent tag add does nothing then. */
  isUserPurging?(userId: string): boolean;

  /** Gives a tag handle its `.binary` senders. Set only when `binary()` is listed. */
  addBinarySenders?: AddBinarySenders;
}

const TAG_SENDERS = { broadcast: 'event-first' } as const;

function assertGroupDeclared(
  runtime: Pick<TagsRuntime, 'isTagGroupDeclared'>,
  kind: TagKind,
  group: string,
): void {
  if (runtime.isTagGroupDeclared(kind, group)) return;

  throw new Error(
    `[livething] tag group '${group}' is not declared under tags (${kind}). Add it to your contract's tags: builder or check for a typo.`,
  );
}

function readBag(connection: RuntimeConnection, kind: TagKind): Map<string, Set<string>> {
  return connection.tags[kind];
}

interface MemberBroadcast {
  event: string;
  payload: unknown;
  target: OutgoingTarget;
  /** The label that a failure is logged under. */
  context: string;
}

/**
 * Send one frame to every member: the payload is turned into JSON and stamped once, so every
 * member gets the same payload and delivery metadata. A payload that cannot be sent is logged.
 */
function broadcastToMembers(
  runtime: Pick<TagsRuntime, 'sendToConnections' | 'logger'>,
  members: Iterable<EngineRuntimeTypes.RuntimeConnection>,
  opts: MemberBroadcast,
): void {
  const { event, payload, target, context } = opts;
  forEachIsolated([members], (all) => runtime.sendToConnections(all, { event, payload, target }), {
    context,
    logger: runtime.logger,
  });
}

function makeRefHandle(
  runtime: Pick<
    TagsRuntime,
    'tagMembers' | 'toConnectionInfo' | 'sendToConnections' | 'addBinarySenders' | 'logger'
  >,
  tag: TagKey,
): TagRefHandle {
  const { kind, group, key } = tag;
  const handle: TagRefHandle = {
    __livething: 'tag-ref',
    kind,
    group,
    key,
    broadcast(event: string, payload: unknown) {
      const members = runtime.tagMembers.get(tagRefIndexKey(kind, group, key)) ?? [];
      broadcastToMembers(runtime, members, {
        event,
        payload,
        target: { kind: 'tag', tagKind: kind, group, key },
        context: `tag ref broadcast '${kind}:${group}/${key}' event="${event}"`,
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

  runtime.addBinarySenders?.(handle, TAG_SENDERS);

  return handle;
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

  const persistsDurably = connection.userId.length > 0;

  // The caller is added by hand: an anonymous connection is never in usersByKey,
  // and a closing one may already be out of it.
  function userConnections(): RuntimeConnection[] {
    return [...new Set([...(runtime.usersByKey.get(connection.userId) ?? []), connection])];
  }

  const handle: TagGroupHandle = {
    __livething: 'group-handle',
    kind,
    group,

    add(key: string) {
      // An empty key addresses no bucket. Guard it as a no-op so an untyped
      // t<>() group can't create a phantom "" tag that ref('').broadcast() would
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

      if (runtime.isUserPurging?.(connection.userId)) return;

      const lacking = userConnections().filter((c) => !readBag(c, kind).get(group)?.has(key));
      if (lacking.length === 0) return;

      // Durable write before the live mutation, so a failed SQL write cannot
      // leave the tag live with nothing saved.
      if (persistsDurably) {
        insertTag(runtime.getStorage().sql, { userId: connection.userId, group, key });
      }

      for (const target of lacking) {
        addConnectionTag(runtime.tagMembers, target, { kind, group, key });
      }
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

      const holding = userConnections().filter((c) => readBag(c, kind).get(group)?.has(key));
      if (holding.length === 0) return;

      // Durable delete before the live mutation, for the same reason as add().
      if (persistsDurably) {
        deleteTag(runtime.getStorage().sql, { userId: connection.userId, group, key });
      }

      for (const target of holding) {
        removeConnectionTag(runtime.tagMembers, target, { kind, group, key });
      }
    },

    has(key: string): boolean {
      return readBag(connection, kind).get(group)?.has(key) ?? false;
    },

    broadcast(event: string, payload: unknown) {
      const members = runtime.tagMembers.get(tagGroupIndexKey(kind, group)) ?? [];
      broadcastToMembers(runtime, members, {
        event,
        payload,
        target: { kind: 'tag', tagKind: kind, group },
        context: `tag group broadcast '${kind}:${group}' event="${event}"`,
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

    ref(key: string) {
      // Its `.binary` key is added by `addBinarySenders`, and only when `binary()` is listed.
      return makeRefHandle(runtime, { kind, group, key }) as ReturnType<TagGroupHandle['ref']>;
    },

    list(): readonly TagRef[] {
      const keys = readBag(connection, kind).get(group);
      if (!keys || keys.size === 0) return [];

      return [...keys].map((key) => makeTagRef(kind, group, key));
    },
  };

  runtime.addBinarySenders?.(handle, TAG_SENDERS);

  return handle;
}

/**
 * Build `ctx.tags` — the typed entry point for the tag API.
 */
export function buildTagsApi(runtime: TagsRuntime, connection: RuntimeConnection): TagsApi {
  // A group handle's `.binary` key is added by `addBinarySenders`, only with `binary()`.
  type Handle = ReturnType<TagsApi['ephemeral']>;
  return {
    ephemeral(group: string) {
      return buildGroupHandle(runtime, connection, { kind: 'ephemeral', group }) as Handle;
    },
    persistent(group: string) {
      return buildGroupHandle(runtime, connection, { kind: 'persistent', group }) as Handle;
    },
    list(): readonly TagRef[] {
      return connectionTagRefs(connection);
    },
  };
}
