import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { server as createServerDefinition, emits, t } from '@livething/server';
import { dedup } from '@livething/server/dedup';
import { keepalive } from '@livething/server/keepalive';
import { replay } from '@livething/server/replay';
import { sequence } from '@livething/server/sequence';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { WebSocket } from 'ws';
import { setup } from './setup.ts';
import {
  openRawClient,
  rawRequestListener,
  rawTransport,
  rawTransportOptions,
} from './test-utils.ts';

type Frame = [event: string, payload: Record<string, unknown>, livething: unknown];

/** What `save-and-shout` saw: whether another connection to the file read its write at once. */
const seenByAnotherConnection: number[] = [];

/** What `note-and-nudge` runs in its turn, after its note. */
let nudge: (() => void) | undefined;

function buildDefinition(sqlFile: string, durability: 'strict' | 'best-effort') {
  const base = createServerDefinition({
    authenticate: (request) => ({
      userId: new URL(request.url).searchParams.get('user') ?? 'kofi',
    }),
    capabilities: [
      keepalive(),
      dedup(),
      sequence({ persist: true }),
      replay.history({ exclude: ['heads-up'], durability }),
      emits({ note: t<{ text: string }>(), 'heads-up': t<{ text: string }>() }),
    ],
  });

  const noteToSelf = base.on('note-to-self', {
    run(ctx, input: { text: string }) {
      ctx.send('note', { text: input.text });
    },
  });

  // `heads-up` is not recorded, so its frame is held before the note's row is queued, and the
  // end-of-turn flush comes before the turn's own commit.
  const headsUpThenNote = base.on('heads-up-then-note', {
    run(ctx, input: { text: string }) {
      ctx.send('heads-up', { text: 'a note is coming' });
      ctx.send('note', { text: input.text });
    },
  });

  const noteAndNudge = base.on('note-and-nudge', {
    run(ctx, input: { text: string }) {
      ctx.send('note', { text: input.text });
      nudge?.();
    },
  });

  const bigNoteToSelf = base.on('big-note-to-self', {
    run(ctx, input: { text: string }) {
      ctx.send('note', { text: input.text + 'x'.repeat(70 * 1024) });
    },
  });

  // A broadcast skips its sender, so only the other connections get it.
  const shout = base.on('shout', {
    run(ctx, input: { text: string }) {
      ctx.broadcast('note', { text: input.text });
    },
  });

  const bigShout = base.on('big-shout', {
    run(ctx, input: { text: string }) {
      ctx.broadcast('note', { text: input.text + 'x'.repeat(70 * 1024) });
    },
  });

  const noteToNobody = base.on('note-to-nobody', {
    run(ctx) {
      ctx.users.get('nobody').broadcast('note', { text: 'for nobody' });
    },
  });

  const saveAndShout = base.on('save-and-shout', {
    run(ctx) {
      ctx.sql.exec('CREATE TABLE IF NOT EXISTS saved (text TEXT)');
      ctx.send('note', { text: 'before the save' });
      ctx.sql.exec('INSERT INTO saved VALUES (?)', 'kept');
      const reader = new Database(sqlFile, { readonly: true });
      try {
        const row = reader.prepare('SELECT COUNT(*) AS n FROM saved').get() as { n: number };
        seenByAnotherConnection.push(row.n);
      } finally {
        reader.close();
      }
    },
  });

  return base.assemble({
    handlers: [
      noteToSelf,
      headsUpThenNote,
      noteAndNudge,
      bigNoteToSelf,
      shout,
      bigShout,
      noteToNobody,
      saveAndShout,
    ],
  });
}

interface Running {
  url: string;
  sqlFile: string;
  database: Database.Database;
  admin(): Promise<{ broadcast(event: string, payload: unknown): void }>;
  shutdown(): Promise<void>;
}

const running: Running[] = [];
const directories: string[] = [];

async function start(
  options: { compression?: boolean; durability?: 'strict' | 'best-effort' } = {},
): Promise<Running> {
  const directory = mkdtempSync(join(tmpdir(), 'livething-write-gate-'));
  directories.push(directory);
  const sqlFile = join(directory, 'huddle.sqlite');

  const livething = setup();
  const definition = buildDefinition(sqlFile, options.durability ?? 'strict');
  const endpoint = livething.bind(definition, {
    ...rawTransportOptions,
    sql: sqlFile,
    ...(options.compression ? { compression: true } : {}),
  } as never);

  const httpServer: Server = createServer(rawRequestListener(endpoint));
  httpServer.on('upgrade', endpoint.upgrade);
  await endpoint.ready();
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address() as { port: number };

  const instance: Running = {
    url: `ws://127.0.0.1:${port}/`,
    sqlFile,
    database: new Database(sqlFile, { readonly: true }),
    admin: endpoint.admin as Running['admin'],
    async shutdown() {
      instance.database.close();
      await livething.shutdown();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };

  running.push(instance);

  return instance;
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((instance) => instance.shutdown()));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
  seenByAnotherConnection.length = 0;
  nudge = undefined;
});

interface Client {
  socket: WebSocket;
  frames: Frame[];
  closed: Promise<number>;
}

async function connect(
  instance: Running,
  user = 'kofi',
  options: { perMessageDeflate?: boolean } = {},
): Promise<Client> {
  const socket = openRawClient(`${instance.url}?user=${user}`, options);
  const frames: Frame[] = [];
  const closed = new Promise<number>((resolve) => socket.on('close', (code) => resolve(code)));
  await new Promise<void>((resolve, reject) => {
    socket.on('error', reject);
    socket.on('message', (data) => {
      const frame = JSON.parse(data.toString()) as Frame;
      frames.push(frame);
      if (frame[0] === '__connected__') resolve();
    });
  });

  return { socket, frames, closed };
}

/**
 * Make every replay row with "doomed" in it fail to store. A path that wrote a frame before its
 * row was stored would then deliver a message no client may get.
 */
function doomRows(instance: Running): void {
  const writer = new Database(instance.sqlFile);
  writer.exec(`
    CREATE TRIGGER no_doomed_rows BEFORE INSERT ON __livething_replay
    WHEN NEW.payload LIKE '%doomed%'
    BEGIN SELECT RAISE(ABORT, 'disk full'); END
  `);
  writer.close();
}

/** Send `frame`, and expect the connection closed with no note: its row could not be stored. */
async function expectLost(client: Client, frame: unknown[]): Promise<void> {
  client.socket.send(JSON.stringify(frame));
  const code = await client.closed;

  expect(notes(client)).toBe(0);
  if (rawTransport === 'websocket') expect(code).toBe(1011);
}

function notes(client: Client): number {
  return client.frames.filter(([event]) => event === 'note').length;
}

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  const until = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);

    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('replay rows stored at the write gate, on real better-sqlite3', () => {
  it('delivers the messages whose rows are stored, held or too big to hold', async () => {
    const instance = await start();
    const client = await connect(instance);
    doomRows(instance);

    client.socket.send(JSON.stringify(['heads-up-then-note', { text: 'one' }, null]));
    client.socket.send(JSON.stringify(['big-note-to-self', { text: 'two' }, null]));
    await waitFor(() => notes(client) === 2, 'two notes');
    client.socket.close();
  });

  it('never writes a held message whose row could not be stored', async () => {
    const instance = await start();
    const client = await connect(instance);
    doomRows(instance);

    await expectLost(client, ['heads-up-then-note', { text: 'doomed' }, null]);
  });

  it('never writes a message too big to hold whose row could not be stored', async () => {
    const instance = await start();
    const client = await connect(instance);
    doomRows(instance);

    await expectLost(client, ['big-note-to-self', { text: 'doomed' }, null]);
  });

  it.runIf(rawTransport === 'websocket')(
    'never writes a message on a compressed socket whose row could not be stored',
    async () => {
      const instance = await start({ compression: true });
      const client = await connect(instance);
      doomRows(instance);

      await expectLost(client, ['note-to-self', { text: 'doomed' }, null]);
    },
  );

  it('stores the rows of a turn that writes to no client', async () => {
    const instance = await start();
    const client = await connect(instance);

    client.socket.send(JSON.stringify(['note-to-nobody', {}, null]));
    await waitFor(() => {
      const row = instance.database
        .prepare("SELECT COUNT(*) AS n FROM __livething_replay WHERE userId = 'nobody'")
        .get() as { n: number };
      return row.n === 1;
    }, 'the row for nobody');
    client.socket.close();
  });

  it("does not hold the app's own writes for the end of the turn", async () => {
    const instance = await start();
    const client = await connect(instance);

    client.socket.send(JSON.stringify(['save-and-shout', {}, null]));
    await waitFor(() => notes(client) === 1, 'the note');

    expect(seenByAnotherConnection).toEqual([1]);
    client.socket.close();
  });

  it('sends no message whose row could not be stored, and closes the connections that held one', async () => {
    const instance = await start();
    const sender = await connect(instance, 'kofi');
    const listener = await connect(instance, 'ama');
    doomRows(instance);

    sender.socket.send(JSON.stringify(['shout', { text: 'doomed' }, null]));
    const code = await listener.closed;

    expect(notes(listener)).toBe(0);
    if (rawTransport === 'websocket') expect(code).toBe(1011);

    // The sender held no frame of the lost message, so it stays open.
    sender.socket.send(JSON.stringify(['note-to-self', { text: 'still here' }, null]));
    await waitFor(() => notes(sender) === 1, 'the sender’s note');
    sender.socket.close();
  });

  // The first listener's write runs the failed commit. The others must not get the message either.
  async function expectNoListenerGetsIt(
    event: string,
    options: { compression?: boolean } = {},
  ): Promise<void> {
    const instance = await start(options);
    const sender = await connect(instance, 'kofi');
    const listeners = await Promise.all(
      ['ama', 'yaw', 'esi'].map((user) => connect(instance, user)),
    );
    doomRows(instance);

    sender.socket.send(JSON.stringify([event, { text: 'doomed' }, null]));
    const codes = await Promise.all(listeners.map((listener) => listener.closed));

    expect(listeners.map(notes)).toEqual([0, 0, 0]);
    if (rawTransport === 'websocket') expect(codes).toEqual([1011, 1011, 1011]);
    sender.socket.close();
  }

  it('sends a message too big to hold to no listener once its row fails', async () => {
    await expectNoListenerGetsIt('big-shout');
  });

  it.runIf(rawTransport === 'websocket')(
    'sends a message to no compressed listener once its row fails',
    async () => {
      await expectNoListenerGetsIt('shout', { compression: true });
    },
  );

  it.runIf(rawTransport === 'websocket')(
    'drops the message for a listener that holds frames, after a compressed listener’s write failed',
    async () => {
      const instance = await start({ compression: true });
      const sender = await connect(instance, 'kofi');
      const compressed = await connect(instance, 'ama');
      const holding = await connect(instance, 'yaw', { perMessageDeflate: false });
      doomRows(instance);

      sender.socket.send(JSON.stringify(['shout', { text: 'doomed' }, null]));
      const codes = await Promise.all([compressed.closed, holding.closed]);

      expect([notes(compressed), notes(holding)]).toEqual([0, 0]);
      expect(codes).toEqual([1011, 1011]);
      sender.socket.close();
    },
  );

  it('still sends a best-effort message whose row could not be stored', async () => {
    const instance = await start({ durability: 'best-effort' });
    const sender = await connect(instance, 'kofi');
    const listener = await connect(instance, 'ama');
    doomRows(instance);

    sender.socket.send(JSON.stringify(['shout', { text: 'doomed' }, null]));
    await waitFor(() => notes(listener) === 1, 'the note');

    // A failed best-effort row closes no connection: the listener still gets the next note.
    sender.socket.send(JSON.stringify(['shout', { text: 'next' }, null]));
    await waitFor(() => notes(listener) === 2, 'the next note');
    sender.socket.close();
    listener.socket.close();
  });

  it('closes no connection of another endpoint when a row fails to store', async () => {
    const huddle = await start();
    const standup = await start();
    const kofi = await connect(huddle, 'kofi');
    const ama = await connect(standup, 'ama');
    const standupAdmin = await standup.admin();

    doomRows(huddle);
    nudge = () => standupAdmin.broadcast('note', { text: 'standup in 5' });

    await expectLost(kofi, ['note-and-nudge', { text: 'doomed' }, null]);
    await waitFor(() => notes(ama) === 1, 'the standup note');
    ama.socket.close();
  });
});
