import type { ConnectionInfo, TagRef } from '~/context.ts';

/** Discriminator for a tag group's storage policy. */
export type TagKind = 'ephemeral' | 'persistent';

/**
 * A `TagRef` returned from a `GroupHandle.ref(key)` call. Same data as a
 * plain `TagRef` plus the methods that act on the group of connections
 * matching that exact `(kind, group, key)`. Anywhere a plain `TagRef` is
 * accepted (`onUpgrade` return, `ConnectionInfo.tags`, `channelHandle.kick`),
 * a `TagRefHandle` works too — the methods are stripped at serialization.
 */
export interface TagRefHandle<Meta = Record<string, unknown>> extends TagRef {
  /** Send an event to every connection on this instance with this tag. */
  send(event: string, payload: unknown): void;
  /** Snapshot of every connection on this instance with this tag. */
  connections(): ConnectionInfo<Meta>[];
  /** Number of connections on this instance with this tag. */
  count(): number;
}

/**
 * Handle for one declared tag group. Returned from `ctx.tags.<kind>(group)`.
 * Carries every operation that targets the group as a whole and builds refs
 * for one specific key inside the group.
 */
export interface GroupHandle<Meta = Record<string, unknown>> {
  /** Brand tag so the type cannot be confused with a plain object. */
  readonly __wskit: 'group-handle';
  /** Whether this group is ephemeral or persistent. */
  readonly kind: TagKind;
  /** Group name as declared in the contract's `tags:` builder. */
  readonly group: string;

  /** Add `key` to the current connection's set under this group. */
  add(key: string): void;
  /** Remove `key` from the current connection's set under this group. */
  remove(key: string): void;
  /** Whether the current connection holds `key` under this group. */
  has(key: string): boolean;

  /** Send an event to every connection on this instance with any key under this group. */
  send(event: string, payload: unknown): void;
  /** Snapshot of every connection on this instance with any key under this group. */
  connections(): ConnectionInfo<Meta>[];
  /** Number of distinct connections on this instance with any key under this group. */
  count(): number;
  /** Active keys under this group across every connection on this instance. */
  keys(): readonly string[];

  /** Build a `TagRefHandle` addressing one specific `(kind, group, key)`. */
  ref(key: string): TagRefHandle<Meta>;
  /** Current connection's keys under this group. */
  list(): readonly TagRef[];
}

/**
 * The surface attached to `ctx.tags`. Two methods — one per kind — return a
 * typed group handle. `ephemeral(name)` only accepts group names declared
 * under the `tags:` builder (`ephemeral` kind); likewise for `persistent`.
 */
export interface TagsApi<
  TEphemeralGroups extends string = string,
  TPersistentGroups extends string = string,
  Meta = Record<string, unknown>,
> {
  ephemeral(group: TEphemeralGroups): GroupHandle<Meta>;
  persistent(group: TPersistentGroups): GroupHandle<Meta>;
  /** Every tag ref currently attached to the current connection. */
  list(): readonly TagRef[];
}
