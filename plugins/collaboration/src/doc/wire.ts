// What the server plugin and the client plugin agree on.
//
// Every doc is one room of the plugin's `docs` channel family, named `<type>:<id>`, such as
// `task-board:launch`. A doc type can't hold `:`, so the type ends at the first one, and the
// ID can be any text up to the channel name limit.
//
// The doc's content goes as binary messages on that room. An update bigger than `PART_BYTES`
// goes in parts, both ways, each with `part: [index, count]`; the parts of one update come
// one after another, with nothing between them.
// - `sync` (a request): the client sends its Yjs state vector. The server first sends what the
//   client is missing as an `update`, then answers with its own state vector (base64) and the
//   client's access, with no bytes. The client then sends what the server is missing.
// - `update` (client to server): a Yjs update, with a number `n` the server echoes in `ack`
//   or `refused`.
// - `update` (server to client): what a client is missing after a `sync`, someone else's
//   update, or a server-side change.
// - `ack`: the server took update `n`. It is live, and every member has it. If storing it
//   failed, the server keeps the doc loaded and stores it later.
// - `refused`: the server refused update `n`. The bytes undo it, when it was applied.
// - `save-version`, `list-versions` and `delete-version` (JSON requests): save the doc as it is
//   now, list the saved versions, newest first, and delete one.
// - `read-version` (a binary request): the client names the version and a number `n`. The
//   server sends the version's Yjs state as `version` messages with that `n`, in parts like an
//   update, then answers with the version's info and no bytes.

import { wellFormed } from '~/doc/storable.ts';

/** The plugin's ID, and the namespace of its wire names. */
export const PLUGIN_ID = 'livething:collaboration';

/** The plugin's channel family. */
export const FAMILY = 'docs';

/** The template of the family's room names. */
export const ROOM_TEMPLATE = '{type}:{id}';

/** The longest room name, `<type>:<id>`: LiveThing's limit on a channel name. */
const MAX_ROOM_NAME = 256;

/** The room of one doc. */
export function roomName(type: string, id: string): string {
  return `${type}:${id}`;
}

/**
 * Why `id` can't be a doc ID of `type`, or `null`. Half of an emoji alone is refused: the
 * wire and SQL store it as U+FFFD, so two such IDs would share one doc.
 */
export function docIdProblem(type: string, id: unknown): string | null {
  return typeof id === 'string' &&
    id !== '' &&
    roomName(type, id).length <= MAX_ROOM_NAME &&
    wellFormed(id)
    ? null
    : `collaboration: a doc ID must be a string of 1 to ${MAX_ROOM_NAME - type.length - 1} characters, with no half of an emoji alone`;
}

/**
 * The biggest piece of an update in one message, both ways: it fits a `http()` POST (512 KiB
 * by default) and any send limit of 512 KiB or more.
 */
export const PART_BYTES = 256 * 1024;

/** The most parts one update from a client can have. */
export const MAX_PARTS = 256;

/** The most bytes of one update from a client, all its parts together. */
export const MAX_UPDATE_BYTES = 32 * 1024 * 1024;

/** What a client can do with a doc. */
export type Access = 'edit' | 'view';

/** The `sync` request's answer. The missing update came before it, as an `update`. */
export interface SyncInfo {
  readonly access: Access;
  /** The server's Yjs state vector, base64. */
  readonly vector: string;
}

/** `[index, count]` of one part of an update that comes in parts. */
type Part = readonly [index: number, count: number];

/** The info of a client's `update`. */
export interface UpdateInfo {
  readonly n: number;
  readonly part?: Part;
}

/** The info of the server's `update`: `null`, or which part this is. */
export type ServerUpdateInfo = { readonly part: Part } | null;

/** One saved version of a doc. */
export interface VersionInfo {
  readonly id: string;
  readonly label: string;
  /** When it was saved, in ms since 1970. */
  readonly createdAt: number;
  /** The user who saved it, or `null` when server code saved it with no author. */
  readonly author: string | null;
}

/** The longest version label, in characters. */
export const MAX_LABEL = 200;

/** The longest delay `setTimeout` keeps. A longer one fires at once. */
export const MAX_DELAY_MS = 2_147_483_647;

/** The info of a `read-version` request: which version, and the `n` its `version` parts carry. */
export interface ReadVersionInfo {
  readonly id: string;
  readonly n: number;
}

/** The info of a `version` message: a piece of the version read `n` asked for. */
export interface VersionPartInfo {
  readonly n: number;
  readonly part?: Part;
}

/**
 * The reason of a refusal for an update that starts past what the server has, as when an
 * earlier update was lost. The client then syncs again, which sends all the server lacks.
 */
export const OUT_OF_ORDER = 'the update needs earlier updates the server does not have';

/** The info of a `refused` message. */
export interface RefusedInfo {
  readonly n: number;
  readonly reason: string;
}

/**
 * Each member's awareness state on the wire. The app's own state (typed by the doc's
 * `awareness` schema) is `user`; the rest belongs to the plugin.
 */
export interface WireAwareness {
  /** The app's state, or `null` when it set none. */
  readonly user: unknown;
  /** This copy's Yjs client ID, so editors can match cursors to members. */
  readonly yjs: number;
  /** The fields a Yjs editor binding keeps in y-protocols awareness, such as a cursor. */
  readonly editor: Readonly<Record<string, unknown>> | null;
  /** The locks this member holds, by key. */
  readonly locks: readonly string[];
}
