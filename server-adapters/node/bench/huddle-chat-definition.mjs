// The app the chat benchmarks run: Huddle's room messages, stored in SQLite. `send-message` and
// `react` save a row and go to the room, `start-typing` goes to the room, and `load-history` reads
// the room's last 50 messages.
import { emits, server, t } from '@livething/server';
import { channels } from '@livething/server/channels';
import { clientRequests } from '@livething/server/client-requests';
import { dedup } from '@livething/server/dedup';
import { keepalive } from '@livething/server/keepalive';
import { replay } from '@livething/server/replay';
import { sequence } from '@livething/server/sequence';

/**
 * `keepalive` is for the http() transport, which needs it. `replay` has the engine record every
 * message but `typing` in SQLite, so a client that reconnects gets what it missed.
 */
export function buildHuddleChatDefinition(options = {}) {
  const base = server({
    authenticate(request) {
      return { userId: new URL(request.url).searchParams.get('user') ?? undefined };
    },
    capabilities: [
      channels(),
      clientRequests(),
      ...(options.keepalive ? [keepalive()] : []),
      ...(options.replay
        ? [dedup(), sequence({ persist: true }), replay.history({ exclude: ['typing'] })]
        : []),
    ],
  });

  const rooms = base.channel(['rooms', 'room:{roomId}'], {
    presence: options.presence ?? true,
    capabilities: [emits({ message: t(), reaction: t(), typing: t() })],
  });

  const sendMessage = rooms.on('send-message', {
    run(ctx, input) {
      const message = {
        id: crypto.randomUUID(),
        text: input.text,
        from: ctx.user.id,
        sentAt: Date.now(),
      };

      ctx.sql.exec(
        'INSERT INTO messages (id, room, user_id, text, sent_at) VALUES (?, ?, ?, ?, ?)',
        message.id,
        ctx.channel.name,
        message.from,
        message.text,
        message.sentAt,
      );
      ctx.channel.broadcast('message', message);
    },
  });

  const react = rooms.on('react', {
    run(ctx, input) {
      ctx.sql.exec(
        'INSERT INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)',
        input.messageId,
        ctx.user.id,
        input.emoji,
      );
      ctx.channel.broadcast('reaction', {
        messageId: input.messageId,
        emoji: input.emoji,
        from: ctx.user.id,
      });
    },
  });

  const startTyping = rooms.on('start-typing', {
    run(ctx) {
      ctx.channel.broadcast('typing', { from: ctx.user.id });
    },
  });

  const loadHistory = rooms.request('load-history', {
    run(ctx, input) {
      const messages = ctx.sql
        .exec(
          'SELECT id, text, user_id AS "from", sent_at AS sentAt FROM messages ' +
            'WHERE room = ? AND sent_at < ? ORDER BY sent_at DESC LIMIT 50',
          ctx.channel.name,
          input?.before ?? Date.now() + 1,
        )
        .toArray();
      return { messages };
    },
  });

  return base.assemble({ handlers: [sendMessage, react, startTyping, loadHistory] });
}
