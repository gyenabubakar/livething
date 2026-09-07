import { expect, test } from '@playwright/test';

// Two channel families whose qualified names could be confused by naive
// concatenation:
// - family 'rooms' + scope value 'private-lobby' → "rooms/private-lobby"
// - family 'rooms-private' + scope value 'lobby' → "rooms-private/lobby"
// The engine keys on (family, scope-value) tuples, so they stay isolated.

test.describe('channel-key-collision', () => {
  test('two families with overlapping qualified names stay isolated for broadcast', async ({
    page,
  }, testInfo) => {
    const room = `collide-${testInfo.testId}`;
    await page.goto(`/channel-key-collision?room=${room}`);

    const handle = await page.evaluateHandle(
      async ({ room }) => {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';

        function open(username: string): Promise<{
          ws: WebSocket;
          messages: { event: string; payload: Record<string, unknown> }[];
        }> {
          return new Promise((resolve, reject) => {
            const ws = new WebSocket(
              `${proto}//${location.host}/ws/channel-key-collision?username=${encodeURIComponent(username)}&room=${encodeURIComponent(room)}`,
            );
            const messages: { event: string; payload: Record<string, unknown> }[] = [];
            ws.onmessage = (ev) => {
              if (typeof ev.data !== 'string') return;

              messages.push(JSON.parse(ev.data));
            };
            ws.onopen = () => resolve({ ws, messages });
            ws.onerror = (e) => reject(e);
          });
        }

        const memberA = await open('memberA');
        const memberB = await open('memberB');
        const broadcaster = await open('broadcaster');

        return { memberA, memberB, broadcaster };
      },
      { room },
    );

    async function send(name: 'memberA' | 'memberB' | 'broadcaster', frame: unknown) {
      await page.evaluate(
        ({ h, name, frame }) =>
          (h as unknown as Record<string, { ws: WebSocket }>)[name]!.ws.send(JSON.stringify(frame)),
        { h: handle, name, frame },
      );
    }

    async function messages(
      name: 'memberA' | 'memberB' | 'broadcaster',
    ): Promise<{ event: string; payload: Record<string, unknown> }[]> {
      return page.evaluate(
        ({ h, name }) =>
          (
            h as unknown as Record<
              string,
              { messages: { event: string; payload: Record<string, unknown> }[] }
            >
          )[name]!.messages.slice(),
        { h: handle, name },
      );
    }

    // memberA subscribes to family 'rooms' on name 'private-lobby'.
    await send('memberA', {
      event: '__subscribe__',
      payload: {},
      __wskit: { channel: 'private-lobby', channelFamily: 'rooms' },
    });
    // memberB subscribes to family 'rooms-private' on name 'lobby'.
    await send('memberB', {
      event: '__subscribe__',
      payload: {},
      __wskit: { channel: 'lobby', channelFamily: 'rooms-private' },
    });

    await expect
      .poll(async () => (await messages('memberA')).some((m) => m.event === '__subscribeOk__'))
      .toBe(true);
    await expect
      .poll(async () => (await messages('memberB')).some((m) => m.event === '__subscribeOk__'))
      .toBe(true);

    // Broadcast on family A. Only memberA must receive it.
    await send('broadcaster', {
      event: 'broadcast-a',
      payload: { name: 'private-lobby', text: 'from-A' },
    });
    await expect
      .poll(async () => (await messages('memberA')).some((m) => m.event === 'hello'))
      .toBe(true);
    expect((await messages('memberB')).filter((m) => m.event === 'hello')).toEqual([]);

    // Broadcast on family B. Only memberB must receive it; memberA still has just family A.
    await send('broadcaster', {
      event: 'broadcast-b',
      payload: { name: 'lobby', text: 'from-B' },
    });
    await expect
      .poll(async () => (await messages('memberB')).some((m) => m.event === 'hello'))
      .toBe(true);

    const aHellos = (await messages('memberA')).filter((m) => m.event === 'hello');
    const bHellos = (await messages('memberB')).filter((m) => m.event === 'hello');
    expect(aHellos.map((m) => m.payload.family)).toEqual(['rooms']);
    expect(bHellos.map((m) => m.payload.family)).toEqual(['rooms-private']);
  });
});
