import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { server as createServerDefinition, emits, t } from '@livething/server';
import { sequence } from '@livething/server/sequence';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { Server } from 'node:http';
import { setup } from './setup.ts';

function buildDefinition() {
  const base = createServerDefinition({
    capabilities: [sequence({ persist: true, batchSize: 1 }), emits({ note: t<{}>() })],
  });
  const rolledBack = base.on('rolled-back', {
    run(ctx) {
      ctx.sql.exec('CREATE TABLE IF NOT EXISTS marks (id INTEGER)');
      try {
        ctx.sql.transaction(() => {
          ctx.sql.exec('INSERT INTO marks VALUES (1)');
          ctx.send('note', {});
          ctx.send('note', {});
          throw new Error('roll back');
        });
      } catch {
        // continue
      }

      ctx.send('note', {});
    },
  });
  const commitFails = base.on('commit-fails', {
    run(ctx) {
      ctx.sql.exec('CREATE TABLE IF NOT EXISTS parent (id INTEGER PRIMARY KEY)');
      ctx.sql.exec(
        'CREATE TABLE IF NOT EXISTS child (pid INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)',
      );
      try {
        ctx.sql.transaction(() => {
          ctx.sql.exec('INSERT INTO child VALUES (99)');
          ctx.send('note', {});
        });
      } catch {
        // the commit fails on the deferred foreign key
      }

      ctx.send('note', {});
    },
  });
  const plain = base.on('plain', {
    run(ctx) {
      ctx.send('note', {});
    },
  });

  return base.assemble({ handlers: [rolledBack, commitFails, plain] });
}

interface Running {
  httpServer: Server;
  shutdown(): Promise<void>;
  url: string;
}

async function start(sqlFile: string): Promise<Running> {
  const httpServer = createServer((_request, response) => {
    response.statusCode = 404;
    response.end();
  });
  const livething = setup();
  const endpoint = livething.bind(buildDefinition(), { sql: sqlFile } as never);
  httpServer.on('upgrade', endpoint.upgrade);
  await endpoint.ready();

  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address() as { port: number };

  return {
    httpServer,
    url: `ws://127.0.0.1:${port}/`,
    async shutdown() {
      await livething.shutdown();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

async function collect(url: string, event: string, expected: number): Promise<number[]> {
  const socket = new WebSocket(url);
  const seqs: number[] = [];
  const collected = new Promise<number[]>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `expected ${expected} sequence numbers for "${event}", got ${JSON.stringify(seqs)}`,
          ),
        ),
      2000,
    );
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on('open', () => socket.send(JSON.stringify([event, {}, null])));
    socket.on('message', (data) => {
      const seq = JSON.parse(data.toString())[2]?.delivery?.seq;
      if (typeof seq === 'number') seqs.push(seq);
      if (seqs.length === expected) {
        clearTimeout(timer);
        resolve(seqs);
      }
    });
  });

  try {
    return await collected;
  } finally {
    socket.close();
  }
}

describe('a persisted sequence and a rolled-back user transaction, on real better-sqlite3', () => {
  const directories: string[] = [];
  const running: Running[] = [];

  afterEach(async () => {
    await Promise.all(running.splice(0).map((instance) => instance.shutdown()));
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
  });

  it('never repeats a number, including after a restart on the same file', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'livething-sequence-'));
    directories.push(directory);
    const sqlFile = join(directory, 'app.db');

    const first = await start(sqlFile);
    running.push(first);
    const beforeRestart = await collect(first.url, 'rolled-back', 3);
    await first.shutdown();
    running.pop();

    const second = await start(sqlFile);
    running.push(second);
    const afterRestart = await collect(second.url, 'plain', 1);

    expect([...beforeRestart, ...afterRestart]).toEqual([1, 2, 3, 4]);
  });

  it('never repeats a number when the commit itself fails, including after a restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'livething-sequence-'));
    directories.push(directory);
    const sqlFile = join(directory, 'app.db');

    const first = await start(sqlFile);
    running.push(first);
    const beforeRestart = await collect(first.url, 'commit-fails', 2);
    await first.shutdown();
    running.pop();

    const second = await start(sqlFile);
    running.push(second);
    const afterRestart = await collect(second.url, 'plain', 1);

    expect([...beforeRestart, ...afterRestart]).toEqual([1, 2, 3]);
  });
});
