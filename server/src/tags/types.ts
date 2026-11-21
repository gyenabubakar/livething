import type { BinaryInput } from '@livething/core';
import type { ConnectionInfo, ConnectionRef, TagRef } from '~/context.ts';

/** Discriminator for a tag group's storage policy. */
export type TagKind = 'ephemeral' | 'persistent';

/**
 * A `TagRef` returned from a `TagGroupHandle.ref(key)` call. Same data as a
 * plain `TagRef` plus the methods that act on the group of connections
 * matching that exact `(kind, group, key)`. Anywhere a plain `TagRef` is
 * accepted (`onAuthenticate` return, `ConnectionInfo.tags`, `channelHandle.kick`),
 * a `TagRefHandle` works too — the methods are stripped at serialization.
 */
export interface TagRefHandle<Meta = Record<string, unknown>> extends TagRef {
  /** Broadcast an event to every connection on this instance with this tag. */
  broadcast(event: string, payload: unknown): void;
  /** Snapshot of every connection on this instance with this tag. */
  connections(): ConnectionInfo<Meta>[];
  /** Number of connections on this instance with this tag. */
  count(): number;
  /** Whether the connection addressed by `ref` currently holds this tag. */
  has(ref: ConnectionRef): boolean;
}

/**
 * Handle for one declared tag group. Returned from `ctx.tags.<kind>(group)`.
 * Carries every operation that targets the group as a whole and builds refs
 * for one specific key inside the group.
 */
export interface TagGroupHandle<
  Meta = Record<string, unknown>,
  TSlots = {},
  /** The group's key type, from its `t<T>()` marker or schema. */
  TKey extends string = string,
> {
  /** Brand tag so the type cannot be confused with a plain object. */
  readonly __livething: 'group-handle';
  /** Whether this group is ephemeral or persistent. */
  readonly kind: TagKind;
  /** Group name as declared in the contract's `tags:` builder. */
  readonly group: string;

  /** Add `key` to the current connection's set under this group. */
  add(key: TKey): void;
  /** Remove `key` from the current connection's set under this group. */
  remove(key: TKey): void;
  /** Whether the current connection holds `key` under this group. */
  has(key: TKey): boolean;

  /** Broadcast an event to every connection on this instance with any key under this group. */
  broadcast(event: string, payload: unknown): void;
  /** Snapshot of every connection on this instance with any key under this group. */
  connections(): ConnectionInfo<Meta>[];
  /** Number of distinct connections on this instance with any key under this group. */
  count(): number;
  /** Active keys under this group across every connection on this instance. */
  keys(): readonly string[];

  /** Build a `TagRefHandle` addressing one specific `(kind, group, key)`. */
  ref(key: TKey): TagRefHandle<Meta> & TagBinaryArm<TSlots>;
  /** Current connection's keys under this group. */
  list(): readonly TagRef[];
}

/** The `.binary` key of a tag handle: the binary version of its `broadcast`. */
interface TagBinarySenders<TBinary> {
  /** Send a binary event (its bytes, with `{ info }`) to every connection with this tag. */
  broadcast<E extends keyof TBinary & string>(
    event: E,
    bytes: BinaryInput | undefined,
    ...options: undefined extends TBinary[E]
      ? [options?: { info?: TBinary[E] }]
      : [options: { info: TBinary[E] }]
  ): void;
}

/**
 * A tag handle's `.binary` key: its senders when `binary()` is listed (its capability adds
 * the `binaryOutgoing` slot), else `never`, so any use of it is a compile error.
 */
interface TagBinaryArm<TSlots> {
  readonly binary: TSlots extends { binaryOutgoing: infer TBinary }
    ? TagBinarySenders<TBinary>
    : never;
}

/** A group's key type: its declared type, or `string`. */
type KeyOf<T> = T extends string ? T : string;

/**
 * The surface attached to `ctx.tags`. Two methods — one per kind — return a
 * typed group handle. `ephemeral(name)` only accepts group names declared
 * under the `tags:` builder (`ephemeral` kind); likewise for `persistent`.
 */
export interface TagsApi<
  /** Each declared ephemeral group, by name, with the type of its keys. */
  TEphemeral = Record<string, string>,
  /** Each declared persistent group, by name, with the type of its keys. */
  TPersistent = Record<string, string>,
  Meta = Record<string, unknown>,
  TSlots = {},
> {
  ephemeral<G extends keyof TEphemeral & string>(
    group: G,
  ): TagGroupHandle<Meta, TSlots, KeyOf<TEphemeral[G]>> & TagBinaryArm<TSlots>;
  persistent<G extends keyof TPersistent & string>(
    group: G,
  ): TagGroupHandle<Meta, TSlots, KeyOf<TPersistent[G]>> & TagBinaryArm<TSlots>;
  /** Every tag ref currently attached to the current connection. */
  list(): readonly TagRef[];
}
