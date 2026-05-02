import { expect, test } from '@playwright/test';

test.describe('replay-membership-gate', () => {
  test('a non-member crafting a channel-scoped _replay receives no rows; their connection stays healthy for top-level traffic', async ({
    page,
  }, testInfo) => {
    const room = `gate-${testInfo.testId}`;
    await page.goto(`/replay-membership-gate?room=${room}`);

    const handle = await page.evaluateHandle(
      async ({ room }) => {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';

        function open(username: string): Promise<{
          ws: WebSocket;
          messages: { event: string; payload: Record<string, unknown> }[];
        }> {
          return new Promise((resolve, reject) => {
            const ws = new WebSocket(
              `${proto}//${location.host}/ws/replay-membership-gate?username=${encodeURIComponent(username)}&room=${encodeURIComponent(room)}`,
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

        const member = await open('member');
        const snooper = await open('snooper');
        return { member, snooper };
      },
      { room },
    );

    async function send(name: 'member' | 'snooper', frame: unknown) {
      await page.evaluate(
        ({ h, name, frame }) =>
          (h as unknown as Record<string, { ws: WebSocket }>)[name]!.ws.send(JSON.stringify(frame)),
        { h: handle, name, frame },
      );
    }

    async function messages(
      name: 'member' | 'snooper',
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

    // Member subscribes to the private channel — _subscribeOk arrives.
    await send('member', { event: '_subscribe', payload: { _channel: 'private' } });
    await expect
      .poll(async () => (await messages('member')).some((m) => m.event === '_subscribeOk'))
      .toBe(true);

    // Member asks for a channel replay — they're a member, the row arrives.
    await send('member', { event: '_replay', payload: { since: 0, _channel: 'private' } });
    await expect
      .poll(async () =>
        (await messages('member')).some(
          (m) => m.event === 'secret' && m.payload.text === 'top-secret-history',
        ),
      )
      .toBe(true);

    // Snooper never subscribed. They craft the same _replay frame with the
    // private channel name on it. Pre-fix this returned the secret row;
    // post-fix the server silently acks (no row, no _error).
    await send('snooper', { event: '_replay', payload: { since: 0, _channel: 'private' } });
    // Wait a beat to let any leaked frames arrive.
    await page.waitForTimeout(500);

    const snooperMessages = await messages('snooper');
    const snooperSecrets = snooperMessages.filter((m) => m.event === 'secret');
    expect(snooperSecrets).toEqual([]);

    // Sanity: the snooper's connection is still healthy. A top-level send
    // round-trips successfully — the silent ack didn't break the socket.
    await send('snooper', { event: 'send-beacon', payload: { text: 'still-alive' } });
    await expect
      .poll(async () =>
        (await messages('snooper')).some(
          (m) => m.event === 'top-beacon' && m.payload.text === 'still-alive',
        ),
      )
      .toBe(true);
  });
});
