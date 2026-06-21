import type { RuntimeConnection } from '~/_engine/runtime/types.ts';
import type { TagRef } from '~/context.ts';
import type { TagKind } from '~/tags/types.ts';

/**
 * Core tag-index bookkeeping.
 *
 * The per-connection tag set and the `tagMembers` fan-out index are engine
 * state every connection carries, so the operations that maintain them — used by
 * connection accept/close and by `ConnectionInfo.tags` — live here in the core
 * rather than in the `tags()` feature runtime. A bare handler that never lists
 * `tags()` still drops the group-handle surface; only this small index code,
 * which any connection's lifecycle touches, stays.
 */

function getOrCreateSet(bag: Map<string, Set<string>>, group: string): Set<string> {
  let set = bag.get(group);
  if (!set) {
    set = new Set<string>();
    bag.set(group, set);
  }
  return set;
}

export function tagGroupIndexKey(kind: TagKind, group: string): string {
  return JSON.stringify([kind, group]);
}

export function tagRefIndexKey(kind: TagKind, group: string, key: string): string {
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

export function makeTagRef(kind: TagKind, group: string, key: string): TagRef {
  return { __wskit: 'tag-ref', kind, group, key };
}

/** The public-facing `TagRef` list for one connection, used by `ConnectionInfo.tags`. */
export function connectionTagRefs(connection: RuntimeConnection): readonly TagRef[] {
  const refs: TagRef[] = [];
  for (const [group, keys] of connection.tags.ephemeral) {
    for (const key of keys) refs.push(makeTagRef('ephemeral', group, key));
  }
  for (const [group, keys] of connection.tags.persistent) {
    for (const key of keys) refs.push(makeTagRef('persistent', group, key));
  }
  return refs;
}
