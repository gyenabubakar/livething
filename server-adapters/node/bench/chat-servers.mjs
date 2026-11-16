// The chat app of `huddle-chat-definition.mjs` on plain `ws` and on Socket.IO, and the SQLite
// database that all three servers store it in.
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { WebSocketServer } from 'ws';

/**
 * A new database file in a temporary folder, with the settings a production chat server uses.
 * `search` adds the index that lets a search read the newest messages first and stop at 20 hits,
 * so its cost does not grow with the table.
 */
export function openChatDatabase(options = {}) {
  const database = new Database(join(mkdtempSync(join(tmpdir(), 'huddle-chat-')), 'huddle.sqlite'));
  database.pragma('journal_mode = WAL');
  database.pragma('synchronous = NORMAL');
  database.exec(`
    CREATE TABLE messages (id TEXT PRIMARY KEY, room TEXT NOT NULL, user_id TEXT NOT NULL,
      text TEXT NOT NULL, sent_at INTEGER NOT NULL);
    CREATE INDEX messages_by_room ON messages (room, sent_at);
    CREATE TABLE reactions (message_id TEXT NOT NULL, user_id TEXT NOT NULL, emoji TEXT NOT NULL);
  `);
  if (options.search) database.exec('CREATE INDEX messages_by_time ON messages (sent_at)');

  return database;
}

/** The chat's SQL, as prepared statements: what a server without `ctx.sql` would write. */
function chatStore(database) {
  const insertMessage = database.prepare(
    'INSERT INTO messages (id, room, user_id, text, sent_at) VALUES (?, ?, ?, ?, ?)',
  );
  const insertReaction = database.prepare(
    'INSERT INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)',
  );
  const selectHistory = database.prepare(
    'SELECT id, text, user_id AS "from", sent_at AS sentAt FROM messages ' +
      'WHERE room = ? AND sent_at < ? ORDER BY sent_at DESC LIMIT 50',
  );

  return {
    saveMessage(room, from, text) {
      const message = { id: crypto.randomUUID(), text, from, sentAt: Date.now() };
      insertMessage.run(message.id, room, from, text, message.sentAt);
      return message;
    },
    saveReaction(messageId, from, emoji) {
      insertReaction.run(messageId, from, emoji);
    },
    loadHistory(room, before) {
      return selectHistory.all(room, before ?? Date.now() + 1);
    },
  };
}

/** The chat on plain `ws`, speaking LiveThing's frames. */
export function startPlainWsChat(database, listen) {
  const store = chatStore(database);
  const httpServer = createServer();
  const webSocketServer = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  const rooms = new Map();

  function broadcast(name, sender, frame) {
    for (const member of rooms.get(name) ?? []) {
      if (member !== sender) member.send(frame);
    }
  }

  httpServer.on('upgrade', (request, socket, head) => {
    webSocketServer.handleUpgrade(request, socket, head, (ws) => {
      const userId = new URL(request.url, 'http://x').searchParams.get('user');
      const joined = new Set();
      ws.send(JSON.stringify(['__connected__', {}, null]));
      ws.on('message', (data) => {
        const [event, payload, metadata] = JSON.parse(data.toString());
        const room = metadata?.channel?.name;
        if (event === '__subscribe__') {
          let members = rooms.get(room);
          if (!members) rooms.set(room, (members = new Set()));

          members.add(ws);
          joined.add(room);
          ws.send(JSON.stringify(['__subscribeOk__', {}, metadata]));
        } else if (event === 'send-message') {
          const message = store.saveMessage(room, userId, payload.text);
          broadcast(room, ws, JSON.stringify(['message', message, { channel: metadata.channel }]));
        } else if (event === 'react') {
          store.saveReaction(payload.messageId, userId, payload.emoji);
          const reaction = { messageId: payload.messageId, emoji: payload.emoji, from: userId };
          broadcast(
            room,
            ws,
            JSON.stringify(['reaction', reaction, { channel: metadata.channel }]),
          );
        } else if (event === 'start-typing') {
          broadcast(
            room,
            ws,
            JSON.stringify(['typing', { from: userId }, { channel: metadata.channel }]),
          );
        } else if (event === 'load-history') {
          const messages = store.loadHistory(room, payload?.before);
          ws.send(JSON.stringify(['load-history', { messages }, metadata]));
        }
      });
      ws.on('close', () => {
        for (const name of joined) {
          const members = rooms.get(name);
          members.delete(ws);
          if (members.size === 0) rooms.delete(name);
        }
      });
    });
  });

  return listen(httpServer);
}

/** The chat on Socket.IO, over WebSocket or HTTP long-polling. */
export async function startSocketIoChat(database, listen, transport) {
  const { Server } = await import('socket.io');
  const store = chatStore(database);
  const httpServer = createServer();
  const io = new Server(httpServer, {
    transports: [transport],
    perMessageDeflate: false,
    httpCompression: false,
    serveClient: false,
  });

  io.on('connection', (socket) => {
    const userId = socket.handshake.query.user;
    socket.emit('connected', {});

    socket.on('join', (room, reply) => {
      socket.join(room);
      reply({});
    });
    socket.on('send-message', (room, payload) => {
      socket.to(room).emit('message', store.saveMessage(room, userId, payload.text));
    });
    socket.on('react', (room, payload) => {
      store.saveReaction(payload.messageId, userId, payload.emoji);
      socket
        .to(room)
        .emit('reaction', { messageId: payload.messageId, emoji: payload.emoji, from: userId });
    });
    socket.on('start-typing', (room) => socket.to(room).emit('typing', { from: userId }));
    socket.on('load-history', (room, payload, reply) => {
      reply({ messages: store.loadHistory(room, payload?.before) });
    });
  });

  return listen(httpServer);
}
