import { expect, test } from '@playwright/test';

// Lazy connect + idle timeout under real timers.
test('opens on first use and idle-closes after the timeout', async ({ page }, testInfo) => {
  await page.goto(`/?path=accept&room=${testInfo.testId}&lazy=1&idleMs=500`);

  // Nothing has needed the socket yet, so lazy keeps it closed.
  await expect(page.getByTestId('state')).toHaveText('closed');

  // A send is the first use → the socket opens on demand.
  await page.getByTestId('send-hello').click();
  await expect(page.getByTestId('state')).toHaveText('open');

  // No further use → it idle-closes once the timeout elapses.
  await expect(page.getByTestId('state')).toHaveText('closed', { timeout: 5_000 });
});
