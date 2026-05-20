import { expect, test } from '@playwright/test';

test.describe('channel-key-collision', () => {
  test('two families with `::`-bearing keys/names stay isolated for broadcast and members()', async ({
    page,
  }, testInfo) => {
    const room = `collide-${testInfo.testId}`;

    // Open three independent websockets from one page so test parallelism
    // can't introduce cross-talk. Each socket carries its own subscription
    // state, exactly like three real clients would.
    await page.goto(`/channel-key-collision?room=${room}`);

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
              `${proto}//${location.host}/ws/channel-key-collision?username=${encodeURIComponent(username)}&room=${encodeURIComponent(room)}`,
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

        const memberA = await open('memberA');
        const memberB = await open('memberB');
        const admin = await open('adminUser');

        return { memberA, memberB, admin };
      },
      { room },
    );

    async function send(name: 'memberA' | 'memberB' | 'admin', frame: unknown) {
      await page.evaluate(
        ({ h, name, frame }) =>
          (h as unknown as Record<string, { ws: WebSocket }>)[name]!.ws.send(JSON.stringify(frame)),
        { h: handle, name, frame },
      );
    }

    async function messages(
      name: 'memberA' | 'memberB' | 'admin',
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

    // memberA subscribes to family 'rooms' on name 'private::lobby'.
    await send('memberA', {
      event: '__subscribe__',
      payload: {},
      __wskit: { channel: 'private::lobby', channelScope: 'rooms' },
    });
    // memberB subscribes to family 'rooms::private' on name 'lobby'.
    await send('memberB', {
      event: '__subscribe__',
      payload: {},
      __wskit: { channel: 'lobby', channelScope: 'rooms::private' },
    });

    // Wait for both __subscribeOk__ acks.
    await expect
      .poll(async () => (await messages('memberA')).some((m) => m.event === '__subscribeOk__'))
      .toBe(true);
    await expect
      .poll(async () => (await messages('memberB')).some((m) => m.event === '__subscribeOk__'))
      .toBe(true);

    // members() count for each family is exactly 1 — no key collision.
    await send('admin', { event: 'members-a', payload: { name: 'private::lobby' } });
    await expect
      .poll(
        async () =>
          (await messages('admin')).find((m) => m.event === 'members-result')?.payload.count,
      )
      .toBe(1);

    await send('admin', { event: 'members-b', payload: { name: 'lobby' } });
    await expect
      .poll(async () => {
        const all = (await messages('admin')).filter((m) => m.event === 'members-result');
        return all.at(-1)?.payload.count;
      })
      .toBe(1);

    // Admin broadcasts on family A — only memberA should receive 'hello' from family A.
    await send('admin', {
      event: 'broadcast-a',
      payload: { name: 'private::lobby', text: 'from-A' },
    });
    await expect
      .poll(async () => (await messages('memberA')).some((m) => m.event === 'hello'))
      .toBe(true);

    // memberB must NOT have received family A's broadcast.
    const memberBHellos = (await messages('memberB')).filter((m) => m.event === 'hello');
    expect(memberBHellos).toEqual([]);

    // Admin broadcasts on family B — only memberB should receive.
    await send('admin', { event: 'broadcast-b', payload: { name: 'lobby', text: 'from-B' } });
    await expect
      .poll(async () => (await messages('memberB')).some((m) => m.event === 'hello'))
      .toBe(true);

    // memberA still only has family A's hello — no cross-leak.
    const memberAHellos = (await messages('memberA')).filter((m) => m.event === 'hello');
    expect(memberAHellos.map((m) => m.payload.family)).toEqual(['rooms']);
    const memberBHellosFinal = (await messages('memberB')).filter((m) => m.event === 'hello');
    expect(memberBHellosFinal.map((m) => m.payload.family)).toEqual(['rooms::private']);
  });
});
