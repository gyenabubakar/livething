import { collaboration } from '@livething/plugin-collaboration/server';
import { server } from '@livething/server';
import { channels } from '@livething/server/channels';
import { Disconnect } from '@livething/server/errors';
import { keepalive } from '@livething/server/keepalive';
import * as v from 'valibot';
import type { InferClient } from '@livething/server';
import { requireUsername } from '../_shared/authenticate.ts';
import { huddleDocs } from './docs.ts';

// Huddle's task boards, edited together. Members of a room edit its boards; a user named
// `guest...` may only view them, and one named `outsider...` may not open them.
export const HuddleCollaboration = collaboration({
  docs: huddleDocs,
  access(ctx) {
    const username = String(ctx.meta.username);
    if (username.startsWith('outsider')) return false;

    return username.startsWith('guest') ? 'view' : 'edit';
  },
});

function defineCollaboration(options: { hibernation: boolean }) {
  const base = server({
    authenticate: requireUsername,
    ...(options.hibernation ? { hibernation: true } : {}),
    // keepalive() also makes the e2e servers offer http(), so the suite runs over both transports.
    capabilities: [channels(), keepalive(), HuddleCollaboration()],
  });

  const handleServerDrop = base.on('server-drop', {
    input: v.object({}),
    run() {
      throw Disconnect(4500, 'test drop');
    },
  });

  // A teammate archives a board from Huddle's settings: a change the server makes itself.
  const handleArchiveBoard = base.on('archive-board', {
    input: v.object({ boardId: v.string() }),
    async run(ctx, input) {
      await ctx
        .plugin('livething:collaboration')
        .doc('task-board', input.boardId)
        .change((board) => {
          board.archived = true;
        });
    },
  });

  return base.assemble({ handlers: [handleServerDrop, handleArchiveBoard] });
}

export const collaborationDefinition = defineCollaboration({ hibernation: false });

/** Where the saves Durable Object keeps each board's saved title, as an app would in its own table. */
export function savedTitleKey(boardId: string): string {
  return `saved-title:${boardId}`;
}

/** The part of Cloudflare's `ctx.platform` that `onLoad` and `onSave` here use. */
interface DurableStoragePlatform {
  readonly ctx: {
    readonly storage: {
      get<T>(key: string): Promise<T | undefined>;
      put(key: string, value: string): Promise<void>;
    };
  };
}

// Huddle's boards with the app's own copy of each board's title in the Durable Object's
// storage (Cloudflare only): `onLoad` fills a new board from it, and `onSave` copies the
// title back, 300 ms after the last edit.
const HuddleSavedCollaboration = collaboration({
  docs: huddleDocs,
  access: () => 'edit',
  saveDelayMs: 300,
  async onLoad(ctx, board) {
    if (!board.empty) return;

    const platform = ctx.platform as DurableStoragePlatform;
    const title = await platform.ctx.storage.get<string>(savedTitleKey(board.id));
    if (title !== undefined) {
      board.change((draft) => {
        draft.title = title;
      });
    }
  },
  async onSave(ctx, event) {
    const platform = ctx.platform as DurableStoragePlatform;
    await platform.ctx.storage.put(savedTitleKey(event.id), event.state.title);
  },
});

export const collaborationSavesDefinition = server({
  authenticate: requireUsername,
  hibernation: true,
  capabilities: [channels(), HuddleSavedCollaboration()],
}).assemble({ handlers: [] });

/** The same handlers on a hibernating Durable Object (Cloudflare only). */
export const collaborationHibernationDefinition = defineCollaboration({ hibernation: true });

export type CollaborationClient = InferClient<typeof collaborationDefinition>;
