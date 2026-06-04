import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { connect, frames, installRig, send, waitForFrame } from './_ws-rig.ts';

test.describe('incoming', () => {
  async function openPage(page: Page, room: string) {
    await page.goto(`/incoming?room=${room}`);
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected', { timeout: 15_000 });
  }

  test('incoming handler runs when the matching event arrives', async ({ page }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('send-hello').click();
    await expect(page.getByTestId('echoed')).toHaveText('hello');
  });

  test('__replay__ against a handler without replay enabled is handled gracefully', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    // Send __replay__; server should drop it silently (not crash the connection).
    await page.getByTestId('send-replay').click();
    // Connection must stay alive and process subsequent frames normally.
    await page.getByTestId('send-hello').click();
    await expect(page.getByTestId('echoed')).toHaveText('hello');
    await expect(page.getByTestId('status')).toHaveText('connected');
  });

  test('bad payload is rejected before the handler runs (validator fires)', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    // Send a frame with invalid payload (text is number instead of string).
    // Validator should reject it, handler should not run, onValidationError fires.
    await page.getByTestId('send-bad').click();
    await expect(page.getByTestId('validation-error')).toHaveText('echo-ping');
    // Verify handler never ran: echoed should still be empty.
    await expect(page.getByTestId('echoed')).toHaveText('');
    // Connection stays alive.
    await expect(page.getByTestId('status')).toHaveText('connected');
  });

  test('async handler is awaited before next frame is processed', async ({ page }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    // Send async ping; verify result appears before we send the next frame.
    await page.getByTestId('send-async').click();
    await expect(page.getByTestId('async-result')).toHaveText('async-done');
    // If async handler were not awaited, the order would be unpredictable.
    await page.getByTestId('send-hello').click();
    await expect(page.getByTestId('echoed')).toHaveText('hello');
  });

  test('unregistered event is silently dropped', async ({ page }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    // Send an event that has no handler registered.
    await page.getByTestId('send-unknown').click();
    // Handler never runs, no error fires, connection stays alive.
    await expect(page.getByTestId('status')).toHaveText('connected');
    // Verify subsequent frames work normally.
    await page.getByTestId('send-hello').click();
    await expect(page.getByTestId('echoed')).toHaveText('hello');
  });

  test('frame without event field is dropped', async ({ page }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    // Send a frame with no event field (or invalid JSON).
    await page.getByTestId('send-no-event').click();
    // Invalid JSON is silently dropped, connection stays alive.
    await expect(page.getByTestId('status')).toHaveText('connected');
    await page.getByTestId('send-hello').click();
    await expect(page.getByTestId('echoed')).toHaveText('hello');
  });
});

// The page+testid tests above assert handler/hook effects. These assert the
// raw wire frames a conforming server must emit, using the shared WS rig.
test.describe('incoming — wire contract', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/incoming');
    await installRig(page);
  });

  test('a binary frame to a handler with no onBinary is silently dropped; connection stays alive', async ({
    page,
  }, testInfo) => {
    const room = `inc-bin-${testInfo.testId}`;
    const a = await connect(page, { path: '/ws/incoming', username: 'alice', room });

    await page.evaluate((sid) => window.__wskitSendBinary!(sid, [0x01, 0x02, 0x03]), a);
    await page.waitForTimeout(200);

    const errors = (await frames(page, a)).filter((f) => f.event === '__error__');
    expect(errors).toHaveLength(0);

    // Positive signal: a follow-up text frame still works.
    await send(page, a, { event: 'echo-ping', payload: { text: 'alive' } });
    await waitForFrame(page, a, { match: (f) => f.event === 'echo-pong' });
  });

  test('a bad payload emits an _error frame with code validation-failed', async ({
    page,
  }, testInfo) => {
    const room = `inc-vf-${testInfo.testId}`;
    const a = await connect(page, { path: '/ws/incoming', username: 'alice', room });

    // echo-ping expects { text: string }; send a number to fail validation.
    await send(page, a, { event: 'echo-ping', payload: { text: 123 } });
    const err = await waitForFrame(page, a, {
      match: (f) => f.event === '__error__' && f.payload.code === 'validation-failed',
    });
    expect(err.payload.code).toBe('validation-failed');

    // Connection stays alive.
    await send(page, a, { event: 'echo-ping', payload: { text: 'ok' } });
    await waitForFrame(page, a, { match: (f) => f.event === 'echo-pong' });
  });

  test('a schemaless incoming event accepts any payload shape', async ({ page }, testInfo) => {
    const room = `inc-anything-${testInfo.testId}`;
    const a = await connect(page, { path: '/ws/incoming', username: 'alice', room });

    const weird = { nested: { x: true }, list: [1, 2, 3], n: 42 };
    await send(page, a, { event: 'echo-anything', payload: weird });
    const echo = await waitForFrame(page, a, { match: (f) => f.event === 'anything-echo' });
    expect(echo.payload.got).toEqual(weird);
  });

  test('ctx.send of an undeclared outgoing event surfaces internal-error', async ({
    page,
  }, testInfo) => {
    const room = `inc-undeclared-${testInfo.testId}`;
    const a = await connect(page, { path: '/ws/incoming', username: 'alice', room });

    await send(page, a, { event: 'trigger-send-undeclared', payload: {} });
    const err = await waitForFrame(page, a, {
      match: (f) => f.event === '__error__' && f.payload.code === 'internal-error',
    });
    expect(err.payload.code).toBe('internal-error');

    // Connection stays alive.
    await send(page, a, { event: 'echo-ping', payload: { text: 'ok' } });
    await waitForFrame(page, a, { match: (f) => f.event === 'echo-pong' });
  });

  test('ctx.send with a non-object payload surfaces internal-error', async ({ page }, testInfo) => {
    const room = `inc-badpayload-${testInfo.testId}`;
    const a = await connect(page, { path: '/ws/incoming', username: 'alice', room });

    await send(page, a, { event: 'trigger-send-bad-payload', payload: {} });
    const err = await waitForFrame(page, a, {
      match: (f) => f.event === '__error__' && f.payload.code === 'internal-error',
    });
    expect(err.payload.code).toBe('internal-error');
  });
});
