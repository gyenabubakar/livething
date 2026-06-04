import { expect, test } from '@playwright/test';

// Exercises WebEnvironment's real online/offline wiring feeding network-aware
// reconnection. The signals are the genuine window online/offline events the
// environment subscribes to; the drop is server-driven so timing is exact.
// (Playwright's setOffline is not used — its CDP offline emulation ignores
// loopback, so it never cuts a 127.0.0.1 socket.)
test('pauses reconnection while offline and reconnects on the online event', async ({
  page,
  request,
}, testInfo) => {
  const room = testInfo.testId;
  function setOnline(online: boolean): Promise<void> {
    return page.evaluate(
      (v) => (window as unknown as { __setOnline(o: boolean): void }).__setOnline(v),
      online,
    );
  }
  async function serverCount(): Promise<number> {
    const res = await request.get(`http://127.0.0.1:8788/__count?room=${room}`);
    return ((await res.json()) as { count: number }).count;
  }

  await page.goto(`/tests/puppet/index.html?path=echo&room=${room}&platform=1`);
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('state')).toHaveText('open');
  expect(await serverCount()).toBe(1);

  // Go offline, then drop the socket: network-aware reconnection must hold off.
  await setOnline(false);
  await page.evaluate(() => (window as unknown as { __drop(): void }).__drop());
  await expect(page.getByTestId('state')).not.toHaveText('open', { timeout: 5_000 });

  // Still offline a moment later — no new socket reached the server.
  await page.waitForTimeout(1000);
  expect(await serverCount()).toBe(1);

  // The online event resumes reconnection and a fresh socket opens.
  await setOnline(true);
  await expect(page.getByTestId('state')).toHaveText('open', { timeout: 10_000 });
  await expect(page.getByTestId('open-count')).toHaveText('2');
  expect(await serverCount()).toBe(2);
});
