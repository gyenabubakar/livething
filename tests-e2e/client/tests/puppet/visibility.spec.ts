import { expect, test } from '@playwright/test';

// Exercises WebEnvironment's real document.visibilitychange wiring through the
// platform() primitive — the path node unit tests can only stub.
test('drops the socket after the tab is hidden and reopens it when shown', async ({
  page,
}, testInfo) => {
  await page.goto(
    `/tests/puppet/index.html?path=accept&room=${testInfo.testId}&platform=1&bgMs=200`,
  );
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('state')).toHaveText('open');

  await page.evaluate(() =>
    (window as unknown as { __setVisibility(v: string): void }).__setVisibility('hidden'),
  );
  await expect(page.getByTestId('state')).toHaveText('closed', { timeout: 5_000 });

  await page.evaluate(() =>
    (window as unknown as { __setVisibility(v: string): void }).__setVisibility('visible'),
  );
  await expect(page.getByTestId('state')).toHaveText('open', { timeout: 5_000 });
  await expect(page.getByTestId('open-count')).toHaveText('2');
});
