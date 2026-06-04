import { expect, test } from '@playwright/test';

// Real ArrayBuffer over a real socket, decoded back through the serialization
// primitive's parseBinary — a path the Node unit tests can't exercise.
test('round-trips a binary frame through a real socket', async ({ page }, testInfo) => {
  await page.goto(`/tests/puppet/index.html?path=echo&room=${testInfo.testId}&binary=1`);
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('state')).toHaveText('open');

  await page.getByTestId('send-binary').click();
  // The server echoes the raw bytes; parseBinary turns them back into a frame.
  await expect(page.getByTestId('binary-echo')).toHaveText('1,2,3,4');
});
