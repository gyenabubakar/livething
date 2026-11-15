import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';

/** The next frame after the `__connected__` frame, which these tests do not check. */
function nextMessage(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    socket.addEventListener('message', function onMessage(event) {
      const frame = JSON.parse(String(event.data));
      if (Array.isArray(frame) && frame[0] === '__connected__') return;

      socket.removeEventListener('message', onMessage);
      resolve(frame);
    });
    socket.addEventListener(
      'close',
      () => reject(new Error('WebSocket closed before its reply.')),
      { once: true },
    );
  });
}

async function openSocket(name: string): Promise<WebSocket> {
  const stub = env.CTX_SQL_SERVER.get(env.CTX_SQL_SERVER.idFromName(name));
  const response = (await stub.fetch('https://ctx-sql.test/?username=alice', {
    headers: { Upgrade: 'websocket' },
  })) as Response & { webSocket: WebSocket };
  const socket = response.webSocket;
  socket.accept();

  return socket;
}

it('rolls back only the inner writes when a nested transaction fails and the outer catches it', async () => {
  const socket = await openSocket('nested-transactions');

  const reply = nextMessage(socket);
  socket.send(JSON.stringify(['sql-tx-nested-probe', {}, null]));

  const [event, payload] = (await reply) as [string, { notes: { title: string }[] }];
  expect(event).toBe('notes-list');
  expect(payload.notes.map((note) => note.title)).toEqual(['nested-outer']);
  socket.close();
});

it('keeps a task, and its alarm, scheduled inside a rolled-back transaction while the user write rolls back', async () => {
  const name = 'engine-writes-survive-rollback';
  const socket = await openSocket(name);

  const scheduledRows = nextMessage(socket);
  socket.send(JSON.stringify(['sql-tx-engine-probe', {}, null]));

  const [event, payload] = (await scheduledRows) as [string, { taskIds: string[] }];
  expect(event).toBe('scheduled-rows');
  expect(payload.taskIds).toEqual(['probe-task']);

  const notes = (await nextMessage(socket)) as [string, { notes: { title: string }[] }];
  expect(notes[0]).toBe('notes-list');
  expect(notes[1].notes.map((note) => note.title)).not.toContain('engine-probe');

  const stub = env.CTX_SQL_SERVER.get(env.CTX_SQL_SERVER.idFromName(name));
  const alarm = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
  expect(alarm).toBeGreaterThan(Date.now());
  socket.close();
});

it('turns a deferred foreign key violation at commit into an error the handler can catch', async () => {
  const socket = await openSocket('deferred-foreign-key');

  const reply = nextMessage(socket);
  socket.send(JSON.stringify(['sql-tx-deferred-key-probe', {}, null]));

  const [event, payload] = (await reply) as [string, { error: string; rows: number }];
  expect(event).toBe('deferred-key-result');
  expect(payload.error).toMatch(/FOREIGN KEY constraint failed/);
  expect(payload.rows).toBe(0);
  socket.close();
});
