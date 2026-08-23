import { evictDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';

function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    socket.addEventListener(
      'message',
      (event) => resolve(JSON.parse(String(event.data)) as Record<string, unknown>),
      { once: true },
    );
    socket.addEventListener(
      'close',
      () => reject(new Error('WebSocket closed before its reply.')),
      { once: true },
    );
  });
}

it('restores connection tags and metadata when a hibernating socket wakes', async () => {
  const stub = env.HIBERNATION_SERVER.get(env.HIBERNATION_SERVER.idFromName('hibernation-wake'));
  const response = (await stub.fetch('https://hibernation.test/?username=alice', {
    headers: { Upgrade: 'websocket' },
  })) as Response & { webSocket: WebSocket };
  const socket = response.webSocket;
  socket.accept();

  const tagged = nextMessage(socket);
  socket.send(JSON.stringify({ event: 'tag-self', payload: { tag: 'vip' } }));
  expect((await tagged).payload).toEqual({ tags: ['user:alice', 'label:vip'] });

  await evictDurableObject(stub);

  const afterWake = nextMessage(socket);
  socket.send(
    JSON.stringify({ event: 'send-to-tag', payload: { tag: 'vip', text: 'after wake' } }),
  );
  expect(await afterWake).toMatchObject({
    event: 'tagged-message',
    payload: { text: 'after wake', from: 'alice' },
  });
});
