import { expect, test } from '@playwright/test';

test('reconnects over a real socket after the server drops it', async ({
  page,
  request,
}, testInfo) => {
  const room = testInfo.testId;
  await page.goto(`/?path=drop-once&room=${room}&reconnect=1`);
  await page.getByTestId('connect').click();

  // First open, server terminates the socket, reconnection opens a second one.
  await expect(page.getByTestId('open-count')).toHaveText('2', { timeout: 15_000 });
  await expect(page.getByTestId('state')).toHaveText('open');

  // The server-side count confirms a genuinely new socket opened, not a no-op.
  const res = await request.get(`http://127.0.0.1:8788/__count?room=${room}`);
  expect(((await res.json()) as { count: number }).count).toBe(2);
});
