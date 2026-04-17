import { expect, test } from '@playwright/test';

test.describe('hibernation handler', () => {
  test('main handler preserves tags and sendTo behavior across repeated hibernation wakes', async ({
    page,
  }, testInfo) => {
    const room = `hib-${testInfo.testId}`;
    await page.goto(`/?room=${room}`);

    const result = await page.evaluate(async (currentRoom) => {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';

      type WireMessage =
        | { type: 'json'; event: string; payload: Record<string, unknown> }
        | { type: 'binary'; size: number };

      function open(username: string) {
        return new Promise<{ ws: WebSocket; messages: WireMessage[] }>((resolve, reject) => {
          const ws = new WebSocket(
            `${protocol}//${location.host}/ws?username=${encodeURIComponent(username)}&room=${encodeURIComponent(currentRoom)}`,
          );
          const messages: WireMessage[] = [];

          ws.binaryType = 'arraybuffer';
          ws.onmessage = (event) => {
            if (event.data === 'pong') return;
            if (event.data instanceof ArrayBuffer) {
              messages.push({ type: 'binary', size: event.data.byteLength });
              return;
            }

            const parsed = JSON.parse(event.data as string) as {
              event: string;
              payload: Record<string, unknown>;
            };
            messages.push({ type: 'json', event: parsed.event, payload: parsed.payload });
          };
          ws.onopen = () => resolve({ ws, messages });
          ws.onerror = () => reject(new Error(`failed to open websocket for ${username}`));
        });
      }

      function waitForMessage(
        messages: WireMessage[],
        predicate: (message: WireMessage) => boolean,
        timeoutMs = 5_000,
      ) {
        return new Promise<WireMessage>((resolve, reject) => {
          const startedAt = Date.now();

          function poll() {
            const match = messages.find(predicate);
            if (match) {
              resolve(match);
              return;
            }

            if (Date.now() - startedAt > timeoutMs) {
              reject(new Error('timed out waiting for hibernation message'));
              return;
            }

            setTimeout(poll, 25);
          }

          poll();
        });
      }

      const first = await open('hiber-1');
      const second = await open('hiber-2');

      first.ws.send(JSON.stringify({ event: 'get-connection-info', payload: {} }));
      const initial = (await waitForMessage(
        first.messages,
        (message) => message.type === 'json' && message.event === 'connection-info',
      )) as Extract<WireMessage, { type: 'json' }>;

      second.ws.send(JSON.stringify({ event: 'tag-self', payload: { tag: 'sleepers' } }));
      const tagged = (await waitForMessage(
        second.messages,
        (message) =>
          message.type === 'json' &&
          message.event === 'tag-result' &&
          Array.isArray(message.payload.tags) &&
          message.payload.tags.includes('sleepers'),
      )) as Extract<WireMessage, { type: 'json' }>;

      await new Promise((resolve) => setTimeout(resolve, 150));

      first.ws.send(
        JSON.stringify({
          event: 'send-to-tag',
          payload: { tag: 'sleepers', text: 'hello sleeper' },
        }),
      );

      const delivered = (await waitForMessage(
        second.messages,
        (message) =>
          message.type === 'json' &&
          message.event === 'tagged-message' &&
          message.payload.text === 'hello sleeper',
      )) as Extract<WireMessage, { type: 'json' }>;

      first.ws.close();
      second.ws.close();

      return { initial, tagged, delivered };
    }, room);

    expect(result.initial.payload.count).toBe(2);
    expect(result.initial.payload.connections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          meta: expect.objectContaining({ username: 'hiber-1' }),
          tags: expect.arrayContaining(['hiber-1']),
        }),
        expect.objectContaining({
          meta: expect.objectContaining({ username: 'hiber-2' }),
          tags: expect.arrayContaining(['hiber-2']),
        }),
      ]),
    );
    expect(result.tagged.payload.tags).toContain('sleepers');
    expect(result.delivered.payload.from).toBe('hiber-1');
    expect(result.delivered.payload.text).toBe('hello sleeper');
  });
});
