import { expect, test } from '@playwright/test';

test('opens a real socket, round-trips a sent event, and disconnects', async ({
  page,
}, testInfo) => {
  await page.goto(`/tests/puppet/index.html?path=echo&room=${testInfo.testId}`);
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

test('broad onServerError receives an unsolicited code from a newer server', async ({
  page,
}, testInfo) => {
  await page.goto(`/tests/puppet/index.html?path=unknown-server-error&room=${testInfo.testId}`);
  await expect(page.getByTestId('app-ready')).toHaveText('yes');

  await page.getByTestId('connect').click();
  await expect(page.getByTestId('state')).toHaveText('open');
  await page.getByTestId('send-hello').click();

  await expect(page.getByTestId('server-error-code')).toHaveText('newer-server-error');
  await expect(page.getByTestId('server-error-detail')).toHaveText(
    '{"future":true,"source":"server-v2"}',
  );
  await expect(page.getByTestId('local-error')).toHaveText('');
});

test('plugin broad onServerError receives a stripped unknown plugin code', async ({
  page,
}, testInfo) => {
  await page.goto(
    `/tests/puppet/index.html?path=unknown-plugin-server-error&room=${testInfo.testId}`,
  );
  await expect(page.getByTestId('app-ready')).toHaveText('yes');

  await page.getByTestId('connect').click();
  await expect(page.getByTestId('state')).toHaveText('open');
  await page.getByTestId('send-plugin-error').click();

  await expect(page.getByTestId('plugin-server-error-code')).toHaveText('plugin-future-error');
  await expect(page.getByTestId('plugin-server-error-detail')).toHaveText(
    '{"future":true,"version":2}',
  );
  await expect(page.getByTestId('host-plugin-error-code')).toHaveText('');
  await expect(page.getByTestId('local-error')).toHaveText('');
});
