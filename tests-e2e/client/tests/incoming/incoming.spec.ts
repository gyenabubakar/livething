import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// Conformance: @wskit/client's base on()/send() against the real wskit `incoming`
// server definition. Adapter-oblivious — it talks to whatever server the run booted over
// the /ws proxy.
async function open(page: Page, room: string): Promise<void> {
  await page.goto(`/tests/incoming/index.html?room=${room}&username=alice`);
  await expect(page.getByTestId('app-ready')).toHaveText('yes');
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('status')).toHaveText('open');
}

test.describe('incoming (conformance)', () => {
  test('on() dispatches when the matching event arrives', async ({ page }, testInfo) => {
    await open(page, `inc-dispatch-${testInfo.testId}`);
    await page.getByTestId('ping').click();
    await expect(page.getByTestId('pong')).toHaveText('hello');
  });

  test('multiple handlers for one event stay isolated when one throws', async ({
    page,
  }, testInfo) => {
    await open(page, `inc-isolation-${testInfo.testId}`);
    await page.getByTestId('ping').click();
    await expect(page.getByTestId('handlers')).toHaveText('ABC');
  });

  test('a bad outgoing payload routes a validation-failed error to onServerError', async ({
    page,
  }, testInfo) => {
    await open(page, `inc-validation-${testInfo.testId}`);
    await page.getByTestId('ping-bad').click();
    await expect(page.getByTestId('error-code')).toHaveText('validation-failed');
    // Connection stays alive: a good ping still dispatches.
    await page.getByTestId('ping').click();
    await expect(page.getByTestId('pong')).toHaveText('hello');
  });

  test('an unhandled incoming event is silently ignored', async ({ page }, testInfo) => {
    await open(page, `inc-unhandled-${testInfo.testId}`);
    // anything-echo comes back but has no on() handler — must be dropped silently.
    await page.getByTestId('anything').click();
    // No error surfaced and the connection still dispatches handled events.
    await expect(page.getByTestId('error-code')).toHaveText('');
    await page.getByTestId('unhandled').click();
    await expect(page.getByTestId('pong')).toHaveText('hello');
    await expect(page.getByTestId('status')).toHaveText('open');
  });

  test('a schemaless event accepts any payload', async ({ page }, testInfo) => {
    await open(page, `inc-schemaless-${testInfo.testId}`);
    // echo-anything is schemaless; sending a nested object must not be rejected.
    await page.getByTestId('anything').click();
    await expect(page.getByTestId('error-code')).toHaveText('');
    await page.getByTestId('ping').click();
    await expect(page.getByTestId('pong')).toHaveText('hello');
  });
});
