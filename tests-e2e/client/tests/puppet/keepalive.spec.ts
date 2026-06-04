import { expect, test } from '@playwright/test';

test('measures latency and reports excellent quality when the server pongs', async ({
  page,
}, testInfo) => {
  await page.goto(`/tests/puppet/index.html?path=pong&room=${testInfo.testId}&keepalive=1`);
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('state')).toHaveText('open');

  await expect(page.getByTestId('latency')).toHaveText(/^\d+(\.\d+)?$/, { timeout: 5_000 });
  await expect(page.getByTestId('quality')).toHaveText('excellent', { timeout: 5_000 });
});

test('force-closes the socket after missed pongs when the server is silent', async ({
  page,
}, testInfo) => {
  await page.goto(`/tests/puppet/index.html?path=silent&room=${testInfo.testId}&keepalive=1`);
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('state')).toHaveText('open');

  // No pongs ever arrive → keepalive force-closes after maxMissedPongs.
  await expect(page.getByTestId('state')).toHaveText('closed', { timeout: 5_000 });
});
