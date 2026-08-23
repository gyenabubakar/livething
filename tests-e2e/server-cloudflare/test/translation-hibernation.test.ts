import { evictDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';

function nextMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    socket.addEventListener('message', (event) => resolve(String(event.data)), { once: true });
    socket.addEventListener(
      'close',
      () => reject(new Error('WebSocket closed before its reply.')),
      {
        once: true,
      },
    );
  });
}

it('restores translator state when a hibernating socket wakes', async () => {
  const stub = env.TRANSLATION_HIBERNATION_SERVER.get(
    env.TRANSLATION_HIBERNATION_SERVER.idFromName('translator-wake'),
  );
  const response = (await stub.fetch('https://translation.test/?username=alice', {
    headers: { Upgrade: 'websocket' },
  })) as Response & { webSocket: WebSocket };
  const socket = response.webSocket;
  socket.accept();

  const beforeWake = nextMessage(socket);
  socket.send(JSON.stringify({ type: 'send', text: 'before wake' }));
  expect(JSON.parse(await beforeWake)).toEqual({
    type: 'message',
    name: 'heard',
    body: { text: 'before wake', translatorSequence: 1 },
  });

  await evictDurableObject(stub);

  const afterWake = nextMessage(socket);
  socket.send(JSON.stringify({ type: 'send', text: 'after wake' }));
  expect(JSON.parse(await afterWake)).toEqual({
    type: 'message',
    name: 'heard',
    body: { text: 'after wake', translatorSequence: 2 },
  });
});

it('routes a hibernated ping through the translator instead of Cloudflare edge auto-response', async () => {
  const stub = env.TRANSLATION_HIBERNATION_SERVER.get(
    env.TRANSLATION_HIBERNATION_SERVER.idFromName('translator-ping-wake'),
  );
  const response = (await stub.fetch('https://translation.test/?username=alice', {
    headers: { Upgrade: 'websocket' },
  })) as Response & { webSocket: WebSocket };
  const socket = response.webSocket;
  socket.accept();

  await evictDurableObject(stub);

  const pong = nextMessage(socket);
  socket.send('ping');
  await expect(pong).resolves.toBe('foreign-pong');
});
