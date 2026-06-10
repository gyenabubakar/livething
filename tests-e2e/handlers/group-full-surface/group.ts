import { group, localKey, matches } from '@wskit/server';
import { RejectUpgrade } from '@wskit/server/errors';
import { groupFullSurfaceContract } from './contract.ts';

const GroupRequestKey = localKey<{ tag: string }>('group-request');

export const fullSurfaceGroup = group(groupFullSurfaceContract, (g) =>
  g
    .onUpgrade((request) => {
      const url = new URL(request.url);
      const username = url.searchParams.get('username');
      if (!username) throw RejectUpgrade(4001, 'Missing username');
      return { identity: username, meta: { username } };
    })

    .onInit((ctx) => {
      ctx.sql.exec(
        'CREATE TABLE IF NOT EXISTS _init_check (id INTEGER PRIMARY KEY, ran INTEGER NOT NULL)',
      );
      ctx.sql.exec('INSERT OR REPLACE INTO _init_check (id, ran) VALUES (1, 1)');
      ctx.sql.exec(
        'CREATE TABLE IF NOT EXISTS _disconnect_log (id INTEGER PRIMARY KEY AUTOINCREMENT, identity TEXT NOT NULL, t INTEGER NOT NULL)',
      );
      ctx.sql.exec(
        'CREATE TABLE IF NOT EXISTS _replay_log (id INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT NOT NULL, payload TEXT NOT NULL, seq INTEGER NOT NULL, message_id TEXT NOT NULL)',
      );
      ctx.sql.exec(
        'CREATE TABLE IF NOT EXISTS _scheduled_log (id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER NOT NULL)',
      );
    })

    .onConnect((ctx) => {
      ctx.send('welcome', { username: ctx.meta.username });
    })

    .onDisconnect((ctx) => {
      ctx.sql.exec(
        'INSERT INTO _disconnect_log (identity, t) VALUES (?, ?)',
        ctx.identity,
        Date.now(),
      );
    })

    .onError((ctx, err, event) => {
      ctx.send('error-marker', { event, msg: err instanceof Error ? err.message : String(err) });
    })

    .onValidationError((ctx, event) => {
      ctx.send('validation-marker', { event });
    })

    .intercept((ctx, frame) => {
      ctx.provide(GroupRequestKey, { tag: 'group' });
      ctx.send('pre-intercept-marker', { event: frame.event });
      if (matches(groupFullSurfaceContract, 'chat', frame)) {
        ctx.send('post-intercept-marker', { text: frame.payload.text });
      }
    })

    .rateLimit('chat', { enabled: true, max: 1, windowMs: 60_000 })

    .customReplay({
      onBeforeSend: (ctx, msg) => {
        ctx.sql.exec(
          'INSERT INTO _replay_log (event, payload, seq, message_id) VALUES (?, ?, ?, ?)',
          msg.event,
          JSON.stringify(msg.payload),
          msg.wire.seq,
          msg.wire.messageId,
        );
      },
      onReplay: (ctx, since) => {
        const rows = (
          ctx.sql.exec(
            'SELECT event, payload, seq, message_id FROM _replay_log WHERE seq > ? ORDER BY seq ASC',
            since,
          ) as {
            toArray(): Array<{ event: string; payload: string; seq: number; message_id: string }>;
          }
        ).toArray();
        for (const row of rows) {
          ctx.sendReplay(row.event, JSON.parse(row.payload), {
            seq: row.seq,
            messageId: row.message_id,
          });
        }
      },
    })

    .on('chat', (ctx, payload) => {
      ctx.send('welcome', { username: ctx.meta.username });
      // Use the payload so its shape is exercised; also lets the test
      // distinguish multiple chats from each other.
      ctx.send('rl-marker', { at: payload.text.length });
    })

    .on('bang', () => {
      throw new Error('bang!');
    })

    .on('bad-payload', () => {
      // Never reached — the schema rejects { wrong: true } first.
    })

    .on('check-init', (ctx) => {
      const rows = ctx.sql
        .exec<{ ran: number }>('SELECT ran FROM _init_check WHERE id = 1')
        .toArray();
      const ran = rows[0]?.ran ?? 0;
      ctx.send('init-marker', { ran });
    })

    .on('check-disconnect-log', (ctx, payload) => {
      const rows = ctx.sql
        .exec<{
          count: number;
        }>('SELECT COUNT(*) as count FROM _disconnect_log WHERE identity = ?', payload.identity)
        .toArray();
      ctx.send('goodbye', { username: `seen:${rows[0]?.count ?? 0}` });
    })

    .on('check-scheduled', (ctx) => {
      const rows = ctx.sql
        .exec<{ count: number }>('SELECT COUNT(*) as count FROM _scheduled_log')
        .toArray();
      ctx.send('scheduled-marker', { tickCount: rows[0]?.count ?? 0 });
    })

    .on('start-tick', (ctx) => {
      ctx.schedule('tick', { time: Date.now() + 100 });
    })

    .on('emit-replay-marker', (ctx, payload) => {
      ctx.send('replay-marker', { note: payload.note });
    })

    .request('lookup', (ctx, payload) => {
      ctx.respond({
        found: true,
        hit: payload.id,
        tag: ctx.inject(GroupRequestKey)?.tag ?? 'none',
      });
    })

    .stream('feed', async function* () {
      for (let i = 1; i <= 3; i += 1) {
        yield { idx: i };
        await new Promise((r) => setTimeout(r, 50));
      }
    })

    .resumableStream('paginate', async function* (ctx) {
      const startAt = (ctx.stream.cursor as { idx: number } | null)?.idx ?? 0;
      for (let i = startAt + 1; i <= 5; i += 1) {
        yield ctx.stream.withCursor({ row: i }, { idx: i });
        await new Promise((r) => setTimeout(r, 50));
      }
    })

    .recordedStream('tokens', async function* () {
      for (let i = 1; i <= 5; i += 1) {
        yield { token: `tok-${i}` };
        await new Promise((r) => setTimeout(r, 50));
      }
    })

    .scheduled('tick', (ctx) => {
      ctx.sql.exec('INSERT INTO _scheduled_log (t) VALUES (?)', Date.now());
    })

    .channel('rooms', (ch) =>
      ch.on('send-msg', (ctx, payload) => {
        ctx.channel.broadcast(
          'room-msg',
          { text: payload.text, from: ctx.meta.username },
          { excludeSelf: false },
        );
      }),
    )

    .namespace('v1', (ns) =>
      ns.on('v1-ping', (ctx) => {
        ctx.namespace.send('v1-pong', {});
      }),
    ),
);
