import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// Conformance: @wskit/client's stream() against the real wskit `stream-basic`
// handler. Adapter-oblivious — it talks to whatever server the run booted over
// the /ws proxy.
async function open(page: Page, room: string): Promise<void> {
  await page.goto(`/tests/stream-basic/index.html?room=${room}&username=alice`);
  await expect(page.getByTestId('app-ready')).toHaveText('yes');
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('status')).toHaveText('open');
}

test.describe('stream-basic (conformance)', () => {
  test('stream() resolves on __streamOk__ and yields chunks then exits on __streamEnd__', async ({
    page,
  }, testInfo) => {
    await open(page, `stream-tokens-${testInfo.testId}`);
    await page.getByTestId('start-tokens').click();
    await expect(page.getByTestId('stream-ok')).toHaveText('yes');
    await expect(page.getByTestId('stream-id')).not.toHaveText('');
    await expect(page.getByTestId('chunk-indices')).toHaveText('0,1,2');
    await expect(page.getByTestId('stream-end')).toHaveText('yes');
  });

  test('an unhandled stream throw makes the iterator throw a typed WSKitError', async ({
    page,
  }, testInfo) => {
    await open(page, `stream-boom-${testInfo.testId}`);
    await page.getByTestId('start-boom').click();
    await expect(page.getByTestId('stream-error')).toHaveText('internal-error');
  });

  test('a registered error factory survives as the thrown WSKitError code', async ({
    page,
  }, testInfo) => {
    await open(page, `stream-typed-${testInfo.testId}`);
    await page.getByTestId('start-typed-error').click();
    await expect(page.getByTestId('stream-error')).toHaveText('not-found');
  });

  test('an empty stream ends with no chunks', async ({ page }, testInfo) => {
    await open(page, `stream-empty-${testInfo.testId}`);
    await page.getByTestId('start-empty').click();
    await expect(page.getByTestId('stream-ok')).toHaveText('yes');
    await expect(page.getByTestId('stream-end')).toHaveText('yes');
    await expect(page.getByTestId('chunk-indices')).toHaveText('');
  });

  test('breaking the for-await loop cancels the stream', async ({ page }, testInfo) => {
    await open(page, `stream-break-${testInfo.testId}`);
    await page.getByTestId('start-break').click();
    await expect(page.getByTestId('break-count')).toHaveText('1');
    // The generator's finally fires cancel-observed only when it was cancelled,
    // proving the break reached the server and stopped the stream.
    await expect(page.getByTestId('cancel-observed')).toHaveText('yes');
  });

  test('cancel() mid-stream is observed by the generator', async ({ page }, testInfo) => {
    await open(page, `stream-observe-${testInfo.testId}`);
    await page.getByTestId('start-observe').click();
    await expect(page.getByTestId('cancel-observed')).toHaveText('yes');
  });

  test('two streams in turn have distinct ids', async ({ page }, testInfo) => {
    await open(page, `stream-two-${testInfo.testId}`);
    await page.getByTestId('start-two').click();
    await expect(page.getByTestId('stream-id-1')).not.toHaveText('');
    await expect(page.getByTestId('stream-id-2')).not.toHaveText('');
    await expect(page.getByTestId('ids-distinct')).toHaveText('yes');
  });
});
