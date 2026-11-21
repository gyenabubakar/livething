// Huddle's server Collaboration plugin, as `server/huddle-collaboration.ts` on the Huddle
// reference page shows it.
import { collaboration } from '@livething/plugin-collaboration/server';
import { isRoomMember } from './helpers';
import { huddleDocs } from './huddle-docs';

export const HuddleCollaboration = collaboration({
  docs: huddleDocs,
  async access(ctx, doc) {
    if (!ctx.user.id || !(await isRoomMember(ctx.user.id, doc.id))) return false;

    return ctx.meta.role === 'guest' ? 'view' : 'edit';
  },
});
