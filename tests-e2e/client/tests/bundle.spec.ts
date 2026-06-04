import { expect, test } from '@playwright/test';

// The built bundle and every published subpath export load in a real browser.
test('the built bundle and all subpath exports resolve in the browser', async ({
  page,
}, testInfo) => {
  await page.goto(`/?path=echo&room=${testInfo.testId}`);
  await expect(page.getByTestId('app-ready')).toHaveText('yes');
  await expect(page.getByTestId('subpaths-ok')).toHaveText('yes');
});
