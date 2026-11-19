import { emits, server, t } from '@livething/server';
import { awareness } from '@livething/server/awareness';
import { channels } from '@livething/server/channels';
import { Disconnect } from '@livething/server/errors';
import { keepalive } from '@livething/server/keepalive';
import * as v from 'valibot';
import type { InferClient } from '@livething/server';
import { requireUsername } from '../_shared/authenticate.ts';
import { RoomAwareness } from './events.ts';
import type { RoomViewer } from './events.ts';

/** The largest awareness state a room takes, so a spec can send one that is too large. */
export const ROOM_AWARENESS_MAX_BYTES = 128;

/**
 * A room's awareness window. Longer than the 50 ms default, so a spec can send several
 * updates inside one window without racing the timer.
 */
export const ROOM_AWARENESS_WINDOW_MS = 200;

// Huddle's sign-in, for the tests: a username that starts with `guest` signs in as a guest.
function authenticateMember(request: Request) {
  const { userId } = requireUsername(request);
  const role: 'guest' | 'member' = userId.startsWith('guest') ? 'guest' : 'member';

  return { userId, meta: { userId, name: userId, role } };
}

// Which message each member of a room is reading. A room lists awareness(); the lobby does
// not, so a spec can check the refusal on a channel without it.
function defineAwareness(options: { hibernation: boolean }) {
  const base = server({
    hibernation: options.hibernation,
    authenticate: authenticateMember,
    capabilities: [
      keepalive(),
      channels(),
      emits({ viewers: t<{ roomId: string; viewers: RoomViewer[] }>() }),
    ],
  });

  const handleServerDrop = base.on('server-drop', {
    input: v.object({}),
    run() {
      throw Disconnect(4500, 'test drop');
    },
  });

  const rooms = base.channel(['rooms', 'room:{roomId}'], {
    capabilities: [awareness()],
    awareness: {
      state: RoomAwareness,
      // Guests can read a room, but other members do not see where they are.
      check: (ctx) => ctx.meta.role !== 'guest',
      windowMs: ROOM_AWARENESS_WINDOW_MS,
      maxBytes: ROOM_AWARENESS_MAX_BYTES,
    },
  });

  const lobby = base.channel('lobby', {});

  const handleListViewers = rooms.on('list-viewers', {
    input: v.object({}),
    run(ctx) {
      const viewers = ctx.channel.awareness.list().map((entry) => ({
        connectionId: entry.connectionId,
        name: String(entry.meta.name),
        viewingMessageId: entry.state.viewingMessageId,
      }));
      ctx.send('viewers', { roomId: ctx.channel.params.roomId, viewers });
    },
  });

  // A moderator hides where another member is reading. The member's next update shows it again.
  const handleHideViewer = rooms.on('hide-viewer', {
    input: v.object({ connectionId: v.string() }),
    run(ctx, input) {
      ctx.channel.awareness.set(input.connectionId, null);
    },
  });

  const handleRemoveMember = rooms.on('remove-member', {
    input: v.object({ userId: v.string() }),
    async run(ctx, input) {
      await ctx.channel.kick(ctx.users.get(input.userId).ref(), { reason: 'removed by a member' });
    },
  });

  return base.assemble({
    handlers: [
      handleServerDrop,
      handleListViewers,
      handleHideViewer,
      handleRemoveMember,
      rooms,
      lobby,
    ],
  });
}

export const awarenessDefinition = defineAwareness({ hibernation: false });

/** The same handlers on a hibernating Durable Object (Cloudflare only). */
export const awarenessHibernationDefinition = defineAwareness({ hibernation: true });

export type AwarenessClient = InferClient<typeof awarenessDefinition>;
