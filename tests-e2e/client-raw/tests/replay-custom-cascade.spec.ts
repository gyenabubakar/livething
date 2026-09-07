import { expect, test } from '@playwright/test';

test.describe('replay-custom-cascade', () => {
  test('top-level custom replay receives channel info on cascaded sends and serves filtered replay back', async ({
    page,
  }, testInfo) => {
    const room = `cascade-${testInfo.testId}-${Date.now()}`;
    await page.goto(`/replay-custom-cascade?room=${room}`);

    const handle = await page.evaluateHandle(
      async ({ room }) => {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';

        function open(username: string): Promise<{
          ws: WebSocket;
          messages: {
            event: string;
            payload: Record<string, unknown>;
            __wskit?: Record<string, unknown>;
          }[];
        }> {
          return new Promise((resolve, reject) => {
            const ws = new WebSocket(
              `${proto}//${location.host}/ws/replay-custom-cascade?username=${encodeURIComponent(username)}&room=${encodeURIComponent(room)}`,
            );
            const messages: {
              event: string;
              payload: Record<string, unknown>;
              __wskit?: Record<string, unknown>;
            }[] = [];
            ws.onmessage = (ev) => {
              if (typeof ev.data !== 'string') return;

              messages.push(JSON.parse(ev.data));
            };
            ws.onopen = () => resolve({ ws, messages });
            ws.onerror = (e) => reject(e);
          });
        }

        const first = await open('alice');
        return { first };
      },
      { room },
    );

    async function send(name: 'first' | 'second', frame: unknown) {
      await page.evaluate(
        ({ h, name, frame }) =>
          (h as unknown as Record<string, { ws: WebSocket }>)[name]!.ws.send(JSON.stringify(frame)),
        { h: handle, name, frame },
      );
    }

    async function messagesOf(
      name: 'first' | 'second',
    ): Promise<
      { event: string; payload: Record<string, unknown>; __wskit?: Record<string, unknown> }[]
    > {
      return page.evaluate(
        ({ h, name }) =>
          (
            h as unknown as Record<
              string,
              {
                messages: {
                  event: string;
                  payload: Record<string, unknown>;
                  __wskit?: Record<string, unknown>;
                }[];
              }
            >
          )[name]!.messages.slice(),
        { h: handle, name },
      );
    }

    // Subscribe and broadcast a few channel-scoped notes.
    await send('first', { event: '__subscribe__', payload: {}, __wskit: { channel: 'lobby' } });
    await expect
      .poll(async () => (await messagesOf('first')).some((m) => m.event === '__subscribeOk__'))
      .toBe(true);

    for (const text of ['one', 'two', 'three']) {
      await send('first', { event: 'send-note', payload: { text }, __wskit: { channel: 'lobby' } });
    }

    await expect
      .poll(async () => (await messagesOf('first')).filter((m) => m.event === 'note').length >= 3)
      .toBe(true);

    // Disconnect and open a second connection — fresh message log.
    await page.evaluate(
      ({ h }) => (h as unknown as { first: { ws: WebSocket } }).first.ws.close(),
      {
        h: handle,
      },
    );

    await page.evaluate(
      async ({ h, room }) => {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = await new Promise<WebSocket>((resolve, reject) => {
          const w = new WebSocket(
            `${proto}//${location.host}/ws/replay-custom-cascade?username=${encodeURIComponent('alice2')}&room=${encodeURIComponent(room)}`,
          );
          w.onopen = () => resolve(w);
          w.onerror = (e) => reject(e);
        });
        const messages: {
          event: string;
          payload: Record<string, unknown>;
          __wskit?: Record<string, unknown>;
        }[] = [];
        ws.onmessage = (ev) => {
          if (typeof ev.data !== 'string') return;

          messages.push(JSON.parse(ev.data));
        };
        (h as unknown as Record<string, unknown>).second = { ws, messages };
      },
      { h: handle, room },
    );

    // The replay-membership gate requires the requester to be a current
    // member of the channel they're asking about, so subscribe first.
    await send('second', { event: '__subscribe__', payload: {}, __wskit: { channel: 'lobby' } });
    await expect
      .poll(async () => (await messagesOf('second')).some((m) => m.event === '__subscribeOk__'))
      .toBe(true);

    // Ask the top-level replay handler to replay channel `lobby` from seq 0.
    // This works only because the cascade carried channel info to onBeforeSend
    // earlier so rows were stored with channel='lobby'; and because the top-
    // level onReplay context now exposes the requested channel on `request`.
    await send('second', {
      event: '__replay__',
      payload: { lastKnownSeq: 0 },
      __wskit: { channel: 'lobby' },
    });

    await expect
      .poll(async () => {
        const notes = (await messagesOf('second')).filter((m) => m.event === 'note');
        return notes.length;
      })
      .toBe(3);

    const notes = (await messagesOf('second')).filter((m) => m.event === 'note');
    expect(notes.map((n) => n.payload.text)).toEqual(['one', 'two', 'three']);
    // Wire fields preserved on each replay frame.
    for (const n of notes) {
      expect(n.__wskit?.channel).toBe('lobby');
    }
  });

  test('top-level custom replay forwards _channelFamily on family-channel replay frames', async ({
    page,
  }, testInfo) => {
    // Pre-fix the top-level onReplay context's sendReplay hardcoded
    // channelFamily=null. Replay frames went out with channel='room-7' but
    // no channelFamily='rooms', so the client's family-channel router could
    // not route them.
    const room = `cascade-fam-${testInfo.testId}-${Date.now()}`;
    await page.goto(`/replay-custom-cascade?room=${room}`);

    const handle = await page.evaluateHandle(
      async ({ room }) => {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';

        function open(username: string): Promise<{
          ws: WebSocket;
          messages: {
            event: string;
            payload: Record<string, unknown>;
            __wskit?: Record<string, unknown>;
          }[];
        }> {
          return new Promise((resolve, reject) => {
            const ws = new WebSocket(
              `${proto}//${location.host}/ws/replay-custom-cascade?username=${encodeURIComponent(username)}&room=${encodeURIComponent(room)}`,
            );
            const messages: {
              event: string;
              payload: Record<string, unknown>;
              __wskit?: Record<string, unknown>;
            }[] = [];
            ws.onmessage = (ev) => {
              if (typeof ev.data !== 'string') return;

              messages.push(JSON.parse(ev.data));
            };
            ws.onopen = () => resolve({ ws, messages });
            ws.onerror = (e) => reject(e);
          });
        }

        const first = await open('alice');
        return { first };
      },
      { room },
    );

    async function send(name: 'first' | 'second', frame: unknown) {
      await page.evaluate(
        ({ h, name, frame }) =>
          (h as unknown as Record<string, { ws: WebSocket }>)[name]!.ws.send(JSON.stringify(frame)),
        { h: handle, name, frame },
      );
    }

    async function messagesOf(
      name: 'first' | 'second',
    ): Promise<
      { event: string; payload: Record<string, unknown>; __wskit?: Record<string, unknown> }[]
    > {
      return page.evaluate(
        ({ h, name }) =>
          (
            h as unknown as Record<
              string,
              {
                messages: {
                  event: string;
                  payload: Record<string, unknown>;
                  __wskit?: Record<string, unknown>;
                }[];
              }
            >
          )[name]!.messages.slice(),
        { h: handle, name },
      );
    }

    // Subscribe to family channel `room-7` and broadcast notes there.
    await send('first', {
      event: '__subscribe__',
      payload: {},
      __wskit: { channel: 'room-7', channelFamily: 'rooms' },
    });
    await expect
      .poll(async () => (await messagesOf('first')).some((m) => m.event === '__subscribeOk__'))
      .toBe(true);

    for (const text of ['fam-one', 'fam-two']) {
      await send('first', {
        event: 'send-note',
        payload: { text },
        __wskit: { channel: 'room-7', channelFamily: 'rooms' },
      });
    }

    await expect
      .poll(async () => (await messagesOf('first')).filter((m) => m.event === 'note').length >= 2)
      .toBe(true);

    // Open a second connection and ask for replay of `room-7` in family `rooms`.
    await page.evaluate(
      ({ h }) => (h as unknown as { first: { ws: WebSocket } }).first.ws.close(),
      {
        h: handle,
      },
    );
    await page.evaluate(
      async ({ h, room }) => {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = await new Promise<WebSocket>((resolve, reject) => {
          const w = new WebSocket(
            `${proto}//${location.host}/ws/replay-custom-cascade?username=${encodeURIComponent('alice2')}&room=${encodeURIComponent(room)}`,
          );
          w.onopen = () => resolve(w);
          w.onerror = (e) => reject(e);
        });
        const messages: {
          event: string;
          payload: Record<string, unknown>;
          __wskit?: Record<string, unknown>;
        }[] = [];
        ws.onmessage = (ev) => {
          if (typeof ev.data !== 'string') return;

          messages.push(JSON.parse(ev.data));
        };
        (h as unknown as Record<string, unknown>).second = { ws, messages };
      },
      { h: handle, room },
    );
    await send('second', {
      event: '__subscribe__',
      payload: {},
      __wskit: { channel: 'room-7', channelFamily: 'rooms' },
    });
    await expect
      .poll(async () => (await messagesOf('second')).some((m) => m.event === '__subscribeOk__'))
      .toBe(true);
    await send('second', {
      event: '__replay__',
      payload: { lastKnownSeq: 0 },
      __wskit: { channel: 'room-7', channelFamily: 'rooms' },
    });

    await expect
      .poll(async () => (await messagesOf('second')).filter((m) => m.event === 'note').length)
      .toBe(2);

    const notes = (await messagesOf('second')).filter((m) => m.event === 'note');
    expect(notes.map((n) => n.payload.text)).toEqual(['fam-one', 'fam-two']);
    // Every replayed note frame carries BOTH the channel and the family.
    for (const n of notes) {
      expect(n.__wskit?.channel).toBe('room-7');
      expect(n.__wskit?.channelFamily).toBe('rooms');
    }
  });
});
