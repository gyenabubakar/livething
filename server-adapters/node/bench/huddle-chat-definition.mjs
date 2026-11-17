// The app the chat benchmarks run: Huddle's room messages, stored in SQLite. `send-message` and
// `react` save a row and go to the room, `start-typing` goes to the room, and `load-history` reads
// the room's last 50 messages, or the 50 before the `{ sentAt, id }` of `before`.
import { emits, server, t } from '@livething/server';
import { channels } from '@livething/server/channels';
import { clientRequests } from '@livething/server/client-requests';
import { dedup } from '@livething/server/dedup';
import { inbox, readReceipts } from '@livething/server/inbox';
import { keepalive } from '@livething/server/keepalive';
import { rateLimit } from '@livething/server/rate-limit';
import { replay } from '@livething/server/replay';
import { sequence } from '@livething/server/sequence';
import { serverRequests } from '@livething/server/server-requests';
import { stream } from '@livething/server/streams';

/** The answer to `confirm-delete`, checked as a standard schema. */
const ConfirmDeleteAnswer = {
  '~standard': {
    version: 1,
    vendor: 'huddle',
    validate(value) {
      return typeof value?.confirmed === 'boolean'
        ? { value }
        : { issues: [{ message: 'confirmed must be true or false' }] };
    },
  },
};

/**
 * `keepalive` is for the http() transport, which needs it. `replay` has the engine record every
 * message but `typing` in SQLite, so a client that reconnects gets what it missed. `dedup` gives
 * every message an ID, and `rateLimit` caps each connection at 600 actions a minute, which no
 * bench client reaches. `features` adds direct messages with an inbox and read receipts, a
 * message search that streams its hits, and a delete that asks the client to confirm.
 */
export function buildHuddleChatDefinition(options = {}) {
  const needsSequence = options.replay || options.features;
  const base = server({
    authenticate(request) {
      return { userId: new URL(request.url).searchParams.get('user') ?? undefined };
    },
    capabilities: [
      channels(),
      clientRequests(),
      ...(options.keepalive ? [keepalive()] : []),
      ...(options.dedup || needsSequence ? [dedup()] : []),
      ...(needsSequence ? [sequence({ persist: true })] : []),
      ...(options.replay ? [replay.history({ exclude: ['typing'] })] : []),
      ...(options.rateLimit ? [rateLimit({ windowMs: 60_000, maxMessages: 600 })] : []),
      ...(options.features
        ? [stream(), serverRequests({ 'confirm-delete': { out: t(), in: ConfirmDeleteAnswer } })]
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

      saveMessage(ctx, message);
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
            'WHERE room = ? AND (sent_at, id) < (?, ?) ORDER BY sent_at DESC, id DESC LIMIT 50',
          ctx.channel.name,
          input?.before?.sentAt ?? Date.now() + 1,
          input?.before?.id ?? '',
        )
        .toArray();
      return { messages };
    },
  });

  const handlers = [sendMessage, react, startTyping, loadHistory];
  if (!options.features) return base.assemble({ handlers });

  // A direct message between two users. Each member gets a stored copy until they say they
  // received it, so a member who is away gets it when they come back.
  const dms = base.channel(['dms', 'dm:{pair}'], {
    membership: 'persistent',
    capabilities: [inbox(), readReceipts(), emits({ message: t() })],
    check(ctx) {
      if (!ctx.channel.params.pair.split('-').includes(ctx.user.id)) {
        throw new Error('only the two people in a direct message can join it');
      }
    },
  });

  // Unlike Huddle's event, a request: the sender learns the message is stored, which is how the
  // bench knows the inbox kept it for a member who is away. It is saved like a room message, so
  // the search finds it.
  const sendDm = dms.request('send-message', {
    run(ctx, input) {
      const message = {
        id: crypto.randomUUID(),
        text: input.text,
        from: ctx.user.id,
        sentAt: Date.now(),
      };

      saveMessage(ctx, message);
      ctx.channel.broadcast('message', message);

      return { id: message.id };
    },
  });

  // The hits of a search over every room, as they are found.
  const searchMessages = base.stream('search-messages', {
    async *run(ctx, input) {
      const hits = ctx.sql
        .exec(
          'SELECT id, room, text FROM messages WHERE text LIKE ? ORDER BY sent_at DESC LIMIT 20',
          `%${input.query}%`,
        )
        .toArray();
      for (const hit of hits) yield { hit };
    },
  });

  // The client confirms before the message is gone.
  const deleteMessage = base.request('delete-message', {
    async run(ctx, input) {
      const answer = await ctx.request('confirm-delete', { preview: input.preview });
      if (!answer.confirmed) return { deleted: false };

      const deleted = ctx.sql
        .exec(
          'DELETE FROM messages WHERE id = ? AND user_id = ? RETURNING id',
          input.messageId,
          ctx.user.id,
        )
        .one();

      return { deleted: deleted !== null };
    },
  });

  return base.assemble({
    handlers: [...handlers, sendDm, searchMessages, deleteMessage],
  });
}

function saveMessage(ctx, message) {
  ctx.sql.exec(
    'INSERT INTO messages (id, room, user_id, text, sent_at) VALUES (?, ?, ?, ?, ?)',
    message.id,
    ctx.channel.name,
    message.from,
    message.text,
    message.sentAt,
  );
}
