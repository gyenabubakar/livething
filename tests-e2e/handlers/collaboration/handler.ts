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

/** The same handlers on a hibernating Durable Object (Cloudflare only). */
export const collaborationHibernationDefinition = defineCollaboration({ hibernation: true });

export type CollaborationClient = InferClient<typeof collaborationDefinition>;
