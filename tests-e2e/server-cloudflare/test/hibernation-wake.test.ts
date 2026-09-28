import { evictDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';

function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    socket.addEventListener(
      'message',
      (event) => {
        const frame = JSON.parse(String(event.data));
        if (
          !Array.isArray(frame) ||
          frame.length !== 3 ||
          typeof frame[0] !== 'string' ||
          (frame[2] !== null && (typeof frame[2] !== 'object' || Array.isArray(frame[2])))
        ) {
          reject(new Error('invalid LiveThing wire frame'));
          return;
        }

        resolve({ event: frame[0], payload: frame[1], metadata: frame[2] });
      },
      { once: true },
    );

    socket.addEventListener(
      'close',
      () => reject(new Error('WebSocket closed before its reply.')),
      { once: true },
    );
  });
}

it('closes a hibernating socket with 1003 when the client sends a binary frame', async () => {
  const stub = env.HIBERNATION_SERVER.get(env.HIBERNATION_SERVER.idFromName('hibernation-binary'));
  const response = (await stub.fetch('https://hibernation.test/?username=alice', {
    headers: { Upgrade: 'websocket' },
  })) as Response & { webSocket: WebSocket };
  const socket = response.webSocket;
  socket.accept();

  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    socket.addEventListener('close', ({ code, reason }) => resolve({ code, reason }), {
      once: true,
    });
  });
  socket.send(new Uint8Array([1, 2, 3]));

  await expect(closed).resolves.toEqual({
    code: 1003,
    reason: '[livething] binary frames are not supported yet',
  });
});

it('restores connection tags and metadata when a hibernating socket wakes', async () => {
  const stub = env.HIBERNATION_SERVER.get(env.HIBERNATION_SERVER.idFromName('hibernation-wake'));
  const response = (await stub.fetch('https://hibernation.test/?username=alice', {
    headers: { Upgrade: 'websocket' },
  })) as Response & { webSocket: WebSocket };
  const socket = response.webSocket;
  socket.accept();

  const tagged = nextMessage(socket);
  socket.send(JSON.stringify(['tag-self', { tag: 'vip' }, null]));
  expect((await tagged).payload).toEqual({ tags: ['user:alice', 'label:vip'] });

  await evictDurableObject(stub);

  const afterWake = nextMessage(socket);
  socket.send(JSON.stringify(['send-to-tag', { tag: 'vip', text: 'after wake' }, null]));
  expect(await afterWake).toMatchObject({
    event: 'tagged-message',
    payload: { text: 'after wake', from: 'alice' },
  });
});
