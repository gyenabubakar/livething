import { expect, test } from '@playwright/test';

test('opens a real socket, round-trips a sent event, and disconnects', async ({
  page,
}, testInfo) => {
  await page.goto(`/?path=echo&room=${testInfo.testId}`);
  // The built bundle loaded and wired up the page.
  await expect(page.getByTestId('app-ready')).toHaveText('yes');

  await page.getByTestId('connect').click();
  await expect(page.getByTestId('state')).toHaveText('open');

  await page.getByTestId('send-hello').click();
  await expect(page.getByTestId('last-event')).toHaveText('echoed');
  await expect(page.getByTestId('last-payload')).toContainText('hi');

  await page.getByTestId('disconnect').click();
  await expect(page.getByTestId('state')).toHaveText('closed');
});
