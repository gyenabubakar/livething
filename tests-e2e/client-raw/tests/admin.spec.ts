import { expect, test } from '@playwright/test';

test.describe('admin() over the Worker→DO stub', () => {
  test('purgeUser closes the user’s socket (a built-in op over RPC)', async ({
    page,
  }, testInfo) => {
    const room = `admin-purge-${testInfo.testId}`;
    await page.goto('/');

    const result = await page.evaluate(async (currentRoom) => {
      const ws = new WebSocket(
        `ws://${location.host}/ws/admin?username=alice&room=${encodeURIComponent(currentRoom)}`,
      );
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error('open failed'));
      });
      const closed = new Promise<string>((resolve) => {
        ws.onclose = (event) => resolve(`${event.code}:${event.reason}`);
        setTimeout(() => resolve('timeout'), 5_000);
      });
      await fetch(`/ws/admin/purge?room=${encodeURIComponent(currentRoom)}&userId=alice`, {
        method: 'POST',
      });
      return closed;
    }, room);

    expect(result).toBe('1000:user purged');
  });

  test('a dev-defined op (announce) runs over RPC and reaches connected clients', async ({
    page,
  }, testInfo) => {
    const room = `admin-announce-${testInfo.testId}`;
    await page.goto('/');

    const received = await page.evaluate(async (currentRoom) => {
      const ws = new WebSocket(
        `ws://${location.host}/ws/admin?username=bob&room=${encodeURIComponent(currentRoom)}`,
      );
      const frames: string[] = [];
      ws.addEventListener('message', (event) => {
        if (typeof event.data === 'string') frames.push(event.data);
      });
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error('open failed'));
      });
      await fetch(`/ws/admin/announce?room=${encodeURIComponent(currentRoom)}&text=hello`, {
        method: 'POST',
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      return frames;
    }, room);

    const announced = received
      .map((raw) => JSON.parse(raw) as { event: string; payload: unknown })
      .find((frame) => frame.event === 'announced');
    expect(announced?.payload).toEqual({ text: 'hello' });
  });
});
