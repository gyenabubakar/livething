import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { server as createServerDefinition, emits, t } from '@livething/server';
import { dedup } from '@livething/server/dedup';
import { replay } from '@livething/server/replay';
import { sequence } from '@livething/server/sequence';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { Server } from 'node:http';
import { setup } from './setup.ts';

type Frame = [event: string, payload: Record<string, unknown>, livething: unknown];

function buildDefinition() {
  const base = createServerDefinition({
    upgrade: () => ({ userId: 'kofi' }),
    capabilities: [
      dedup(),
      sequence({ persist: true }),
      replay.history(),
      emits({ note: t<{ text: string }>() }),
    ],
  });
  const noteToSelf = base.on('note-to-self', {
    run(ctx) {
      ctx.send('note', { text: 'akwaaba' });
    },
  });

  return base.assemble({ handlers: [noteToSelf] });
}

interface Running {
  url: string;
  shutdown(): Promise<void>;
}

async function start(sqlFile: string): Promise<Running> {
  const httpServer: Server = createServer((_request, response) => {
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
    url: `ws://127.0.0.1:${port}/`,
    async shutdown() {
      await livething.shutdown();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

/** Open a socket, send `outgoing` once it has its resume token, and collect frames until `done`. */
async function exchange(
  url: string,
  outgoing: (token: string) => unknown[],
  done: (frames: Frame[]) => boolean,
): Promise<Frame[]> {
  const socket = new WebSocket(url);
  const frames: Frame[] = [];
  try {
    return await new Promise<Frame[]>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out with frames ${JSON.stringify(frames)}`)),
        2000,
      );
      socket.on('error', reject);
      socket.on('message', (data) => {
        const frame = JSON.parse(data.toString()) as Frame;
        frames.push(frame);
        if (frame[0] === '__resume__') {
          socket.send(JSON.stringify(outgoing(String(frame[1].token))));
        }

        if (done(frames)) {
          clearTimeout(timer);
          resolve(frames);
        }
      });
    });
  } finally {
    socket.close();
  }
}

describe('replay of a send to one connection, on real better-sqlite3', () => {
  const directories: string[] = [];
  const running: Running[] = [];

  afterEach(async () => {
    await Promise.all(running.splice(0).map((instance) => instance.shutdown()));
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
  });

  it('replays it to a new connection showing the old resume token', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'livething-replay-'));
    directories.push(directory);
    const instance = await start(join(directory, 'app.db'));
    running.push(instance);

    let token = '';
    await exchange(
      instance.url,
      (resumeToken) => {
        token = resumeToken;
        return ['note-to-self', {}, null];
      },
      (frames) => frames.some(([event]) => event === 'note'),
    );

    const replayed = await exchange(
      instance.url,
      () => ['__replay__', { lastKnownSeq: 0, resume: [token] }, null],
      (frames) => frames.some(([event]) => event === 'note'),
    );

    expect(replayed.find(([event]) => event === 'note')?.[1]).toEqual({ text: 'akwaaba' });
  });

  it('replays it after a restart on the same file', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'livething-replay-'));
    directories.push(directory);
    const sqlFile = join(directory, 'app.db');
    const first = await start(sqlFile);
    running.push(first);

    let token = '';
    await exchange(
      first.url,
      (resumeToken) => {
        token = resumeToken;
        return ['note-to-self', {}, null];
      },
      (frames) => frames.some(([event]) => event === 'note'),
    );
    await first.shutdown();
    running.pop();

    const second = await start(sqlFile);
    running.push(second);
    const replayed = await exchange(
      second.url,
      () => ['__replay__', { lastKnownSeq: 0, resume: [token] }, null],
      (frames) => frames.some(([event]) => event === 'note'),
    );

    expect(replayed.find(([event]) => event === 'note')?.[1]).toEqual({ text: 'akwaaba' });
  });
});
