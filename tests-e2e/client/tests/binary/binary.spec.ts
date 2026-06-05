import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// Conformance: @wskit/client's serialization() against the real wskit `binary`
// handler. Adapter-oblivious — it talks to whatever server the run booted over
// the /ws proxy.
async function open(page: Page, room: string): Promise<void> {
  await page.goto(`/tests/binary/index.html?room=${room}&username=alice`);
  await expect(page.getByTestId('app-ready')).toHaveText('yes');
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('status')).toHaveText('open');
}

test.describe('binary (conformance)', () => {
  test('sendBinary reaches the server and the echoed bytes decode into a frame', async ({
    page,
  }, testInfo) => {
    await open(page, `bin-echo-${testInfo.testId}`);
    await page.getByTestId('send-binary').click();
    await expect(page.getByTestId('echo-size')).toHaveText('5');
    await expect(page.getByTestId('echo-username')).toHaveText('echoed-binary');
  });

  test('the server also pushes a JSON binary-meta carrying byte count and username', async ({
    page,
  }, testInfo) => {
    await open(page, `bin-meta-${testInfo.testId}`);
    await page.getByTestId('send-binary').click();
    await expect(page.getByTestId('meta-size')).toHaveText('5');
    await expect(page.getByTestId('meta-username')).toHaveText('alice');
  });

  test('a server-originated binary frame decodes through parseBinary', async ({
    page,
  }, testInfo) => {
    await open(page, `bin-self-${testInfo.testId}`);
    await page.getByTestId('send-self').click();
    await expect(page.getByTestId('echo-size')).toHaveText('7');
    await expect(page.getByTestId('echo-username')).toHaveText('echoed-binary');
  });
});
