import { expect, test } from '@playwright/test';

// `purgeUser` runs each capability's durable cleanup, then closes the user's
// live sockets. Two things used to break that.
//
// The admin server declares `resumableStream()` and no test ever starts a
// stream, so its tables would previously not exist when the purge ran. The
// delete hit a missing table and threw. And because the cleanup loop had no
// error handling, that throw aborted the whole purge before the socket-close
// step — leaving the user's sockets open and other capabilities' rows behind.
//
// The socket closing here proves both: the schema exists from boot, and the
// purge reaches its final step.

test.describe('purgeUser resilience (Worker→DO stub, real Durable Object)', () => {
  test('purges on a server whose durable streams were never used', async ({ page }, testInfo) => {
    const room = `purge-unused-streams-${testInfo.testId}`;
    await page.goto('/');

    const result = await page.evaluate(async (currentRoom) => {
      const ws = new WebSocket(
        `ws://${location.host}/ws/admin?username=carol&room=${encodeURIComponent(currentRoom)}`,
      );
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error('open failed'));
      });
      const closed = new Promise<string>((resolve) => {
        ws.onclose = (event) => resolve(`${event.code}:${event.reason}`);
        setTimeout(() => resolve('timeout'), 5_000);
      });
      const res = await fetch(
        `/ws/admin/purge?room=${encodeURIComponent(currentRoom)}&userId=carol`,
        { method: 'POST' },
      );
      return { closed: await closed, status: res.status };
    }, room);

    // A throwing cleanup step would surface as a non-2xx here.
    expect(result.status).toBeLessThan(400);
    expect(result.closed).toBe('1000:user purged');
  });

  test('purging one user leaves another user connected', async ({ page }, testInfo) => {
    const room = `purge-scoped-${testInfo.testId}`;
    await page.goto('/');

    const result = await page.evaluate(async (currentRoom) => {
      function open(username: string): Promise<WebSocket> {
        const ws = new WebSocket(
          `ws://${location.host}/ws/admin?username=${username}&room=${encodeURIComponent(
            currentRoom,
          )}`,
        );
        return new Promise<WebSocket>((resolve, reject) => {
          ws.onopen = () => resolve(ws);
          ws.onerror = () => reject(new Error(`open failed for ${username}`));
        });
      }

      const target = await open('dave');
      const bystander = await open('erin');

      const targetClosed = new Promise<string>((resolve) => {
        target.onclose = (e) => resolve(`${e.code}:${e.reason}`);
        setTimeout(() => resolve('timeout'), 5_000);
      });
      let bystanderClosed = false;
      bystander.onclose = () => {
        bystanderClosed = true;
      };

      await fetch(`/ws/admin/purge?room=${encodeURIComponent(currentRoom)}&userId=dave`, {
        method: 'POST',
      });
      const closed = await targetClosed;
      await new Promise((r) => setTimeout(r, 500));
      return { closed, bystanderClosed, bystanderState: bystander.readyState };
    }, room);

    expect(result.closed).toBe('1000:user purged');
    expect(result.bystanderClosed).toBe(false);
    expect(result.bystanderState).toBe(1); // OPEN
  });
});
