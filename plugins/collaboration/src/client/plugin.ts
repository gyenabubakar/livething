import { awareness, binary, channels, clientRequests, plugin } from '@livething/client';
import { LiveThingConfigError } from '@livething/core';
import { createDocHandle } from '~/client/doc-handle.ts';
import { docIdProblem, FAMILY, MAX_DELAY_MS, PLUGIN_ID, roomName } from '~/doc/wire.ts';
import { docTypesByName } from '~/schema.ts';
import type { CollaborationWire } from '~/client/contract.ts';
import type { DocHandle, DocRoom } from '~/client/doc-handle.ts';
import type { CollaborationStorage } from '~/doc/storage.ts';
import type { DocDef, DocNamed } from '~/schema.ts';

export interface CollaborationClientOptions<TDocs extends readonly DocDef[]> {
  /** Every doc type the app has: the same list the server gets. */
  readonly docs: TDocs;
  /**
   * Keep docs on the device, so edits made offline survive a reload. `indexedDbStorage()`
   * covers browsers. Default: docs live in memory only.
   */
  readonly storage?: CollaborationStorage;
  /** How long a doc stays joined after its last `close()`, in ms. Default 1000. */
  readonly closeDelayMs?: number;
  /**
   * Gets errors no call can throw: content that does not match the schema (from another app
   * version), a store listener that threw, a failed device write, a change the server can
   * never get (`update-not-sent`), a failed sync after a rejoin, or the server removing this
   * client from a doc. Default: they are reported like an uncaught error.
   */
  onError?(error: unknown): void;
}

/** What `HuddleCollaboration.use(socket)` gives. */
export interface CollaborationClient<TDocs extends readonly DocDef[]> {
  /**
   * One doc, by type and ID. The same object every time for the same doc, like
   * `socket.channel()`. It does nothing on the network until `open()`. A type the app does
   * not list is a type error.
   *
   * @throws {LiveThingConfigError} For an unknown type, or an ID that is empty, too long or holds half of an emoji alone
   * (the type, a `:` and the ID are at most 256 characters).
   */
  doc<N extends TDocs[number]['name']>(type: N, id: string): DocHandle<DocNamed<TDocs, N>>;
}

/**
 * The Collaboration plugin for the client. Returns a plugin factory: list
 * `HuddleCollaboration()` in `client()`, after `channels()`, `binary()`, `awareness()` and
 * `clientRequests()`, and get the docs with `HuddleCollaboration.use(socket)`.
 *
 * @param options `docs` (the same list the server gets), and the optional `storage`,
 * `closeDelayMs` and `onError`.
 * @throws {LiveThingConfigError} When a doc type is listed twice, `docs` is empty, or
 * `closeDelayMs` is not a whole number from 0 to 2147483647.
 *
 * @example
 * ```ts
 * import { awareness, binary, channels, client, clientRequests, connect } from '@livething/client'
 * import { collaboration } from '@livething/plugin-collaboration/client'
 * import { huddleDocs } from '../shared/huddle-docs'
 *
 * export const HuddleCollaboration = collaboration({ docs: huddleDocs })
 *
 * const socket = client<HuddleSocket>()(
 *   connect('wss://huddle.example.com/huddle'),
 *   channels(),
 *   binary(),
 *   awareness(),
 *   clientRequests(),
 *   HuddleCollaboration(),
 * )
 * const board = HuddleCollaboration.use(socket).doc('task-board', 'launch')
 * await board.open()
 * ```
 */
export function collaboration<const TDocs extends readonly DocDef[]>(
  options: CollaborationClientOptions<TDocs>,
) {
  const defs = docTypesByName(options.docs);
  const closeDelayMs = options.closeDelayMs ?? 1000;
  if (!Number.isInteger(closeDelayMs) || closeDelayMs < 0 || closeDelayMs > MAX_DELAY_MS) {
    throw new LiveThingConfigError(
      `collaboration: \`closeDelayMs\` must be a whole number from 0 to ${MAX_DELAY_MS}`,
    );
  }

  return plugin<CollaborationWire, CollaborationClient<TDocs>>()({
    id: PLUGIN_ID,
    dependencies: [channels, binary, awareness, clientRequests],
    setup(socket) {
      const handles = new Map<string, DocHandle<DocDef>>();
      // Not this call's error: report it the way an uncaught error is. An `onError` that throws
      // is reported the same way, so its error never lands inside a Yjs transaction.
      function onError(error: unknown) {
        try {
          if (options.onError) {
            options.onError(error);
            return;
          }
        } catch (thrown) {
          error = thrown;
        }

        queueMicrotask(() => {
          throw error;
        });
      }

      const api: CollaborationClient<TDocs> = {
        doc(type, id) {
          const def = defs.get(type);
          if (!def) throw new LiveThingConfigError(`collaboration: there is no doc type '${type}'`);

          const problem = docIdProblem(type, id);
          if (problem) throw new LiveThingConfigError(problem);

          const room = roomName(type, id);

          let handle = handles.get(room);
          if (!handle) {
            handle = createDocHandle({
              def,
              ref: { type, id },
              room: socket.channel(FAMILY, room) satisfies DocRoom,
              connection: socket.state,
              storage: options.storage,
              closeDelayMs,
              onError,
            });
            handles.set(room, handle);
          }

          return handle as never;
        },
      };

      return { api: () => api };
    },
  });
}
