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

function closeEventWithin(
  socket: WebSocket,
  ms: number,
): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no close event within ${ms}ms`)), ms);
    socket.addEventListener(
      'close',
      ({ code, reason }) => {
        clearTimeout(timer);
        resolve({ code, reason });
      },
      { once: true },
    );
  });
}

async function openHibernatingSocket(instance: string) {
  const stub = env.HIBERNATION_SERVER.get(env.HIBERNATION_SERVER.idFromName(instance));
  const response = (await stub.fetch('https://hibernation.test/?username=alice', {
    headers: { Upgrade: 'websocket' },
  })) as Response & { webSocket: WebSocket };
  const socket = response.webSocket;
  socket.accept();

  return { stub, socket };
}

it('gives a client closing a hibernating socket with 1000 its close event within 2s', async () => {
  const { socket } = await openHibernatingSocket('hibernation-client-close');

  const closed = closeEventWithin(socket, 2_000);
  socket.close(1000, 'leaving');

  await expect(closed).resolves.toMatchObject({ code: 1000 });
});

it('gives a client closing an evicted hibernating socket with 1000 its close event within 2s', async () => {
  const { stub, socket } = await openHibernatingSocket('hibernation-client-close-evicted');

  await evictDurableObject(stub);

  const closed = closeEventWithin(socket, 2_000);
  socket.close(1000, 'leaving');

  await expect(closed).resolves.toMatchObject({ code: 1000 });
});

it('gives a client closing a hibernating socket with no code its close event within 2s', async () => {
  const { socket } = await openHibernatingSocket('hibernation-client-close-no-code');

  const closed = closeEventWithin(socket, 2_000);
  socket.close();

  await expect(closed).resolves.toMatchObject({ code: 1005 });
});

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
    reason: '[livething] this server does not use binary()',
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

declare const process: {
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): void;
  off(event: 'unhandledRejection', listener: (reason: unknown) => void): void;
};

async function unhandledRejectionsDuring(run: () => Promise<void>): Promise<unknown[]> {
  const unhandled: unknown[] = [];
  function listener(reason: unknown): void {
    unhandled.push(reason);
  }

  process.on('unhandledRejection', listener);
  try {
    await run();
    await scheduler.wait(50);
  } finally {
    process.off('unhandledRejection', listener);
  }

  return unhandled;
}

async function caughtFrom(call: () => Promise<unknown>): Promise<unknown> {
  try {
    await call();
  } catch (error) {
    return error;
  }

  throw new Error('expected the call to throw');
}

it('leaves no unhandled rejection when a Worker catches an unknown channel error', async () => {
  const admin = await env.ADMIN_SERVER.get(env.ADMIN_SERVER.idFromName('admin-unknown')).admin();
  let caught: unknown;

  const unhandled = await unhandledRejectionsDuring(async () => {
    caught = await caughtFrom(() => admin.channels.get('nope' as 'lobby').members());
  });

  expect(String(caught)).toContain('channel-not-found');
  expect(unhandled).toEqual([]);
});

it('leaves no unhandled rejection when a Worker catches a missing connection ref error', async () => {
  const admin = await env.ADMIN_SERVER.get(env.ADMIN_SERVER.idFromName('admin-no-ref')).admin();
  let caught: unknown;

  const unhandled = await unhandledRejectionsDuring(async () => {
    caught = await caughtFrom(() => admin.connections.get(undefined as never).close());
  });

  expect(String(caught)).toContain('[livething]');
  expect(unhandled).toEqual([]);
});

it('leaves no unhandled rejection when a Worker reads an unknown user', async () => {
  const admin = await env.ADMIN_SERVER.get(env.ADMIN_SERVER.idFromName('admin-no-user')).admin();
  let info: unknown = 'unset';

  const unhandled = await unhandledRejectionsDuring(async () => {
    info = await admin.users.get('nobody').info();
  });

  expect(info).toBeNull();
  expect(unhandled).toEqual([]);
});
