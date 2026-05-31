import { expect, test } from '@playwright/test';
import { connect, installRig, send, waitForFrame } from './_ws-rig.ts';

test.describe('ctx-kv', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    await page.goto(`/ctx-kv?room=${room}`);
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');
  });

  test('set then get returns the stored value', async ({ page }) => {
    await page.getByTestId('set-basic').click();
    await expect(page.getByTestId('value-basic')).toHaveText('hello');
    await page.getByTestId('get-basic').click();
    await expect(page.getByTestId('value-basic')).toHaveText('hello');
  });

  test('delete removes a stored value (subsequent get returns null)', async ({ page }) => {
    await page.getByTestId('set-gone').click();
    await expect(page.getByTestId('value-gone')).toHaveText('here');

    await page.getByTestId('delete-gone').click();
    await expect(page.getByTestId('value-gone')).toHaveText('null');

    await page.getByTestId('get-gone').click();
    await expect(page.getByTestId('value-gone')).toHaveText('null');
  });

  test('set with ttl expires within the window (get returns null after ttl)', async ({ page }) => {
    await page.getByTestId('set-ttl').click();
    await expect(page.getByTestId('value-ttl')).toHaveText('ephemeral');

    // Handler set ttlMs: 300. Wait safely past it, then get.
    await page.waitForTimeout(900);
    await page.getByTestId('get-ttl').click();
    await expect(page.getByTestId('value-ttl')).not.toHaveText('ephemeral');
  });
  test('get of non-existent key returns null', async ({ page }) => {
    await page.getByTestId('get-nonexistent').click();
    await expect(page.getByTestId('value-nonexistent')).toHaveText('null');
  });
  test('set without ttl then overwrite replaces the value', async ({ page }) => {
    await page.getByTestId('set-overwrite-v1').click();
    await expect(page.getByTestId('value-overwrite')).toHaveText('first');

    await page.getByTestId('set-overwrite-v2').click();
    await expect(page.getByTestId('value-overwrite')).toHaveText('second');

    await page.getByTestId('get-overwrite').click();
    await expect(page.getByTestId('value-overwrite')).toHaveText('second');
  });
  test('delete of non-existent key succeeds silently', async ({ page }) => {
    await page.getByTestId('delete-never-set').click();
    await expect(page.getByTestId('value-never-set')).toHaveText('null');

    await page.getByTestId('get-never-set').click();
    await expect(page.getByTestId('value-never-set')).toHaveText('null');
  });
  test('set then immediate get in one handler interaction returns the value', async ({ page }) => {
    await page.getByTestId('set-get-atomic').click();
    await expect(page.getByTestId('value-atomic')).toHaveText('atomic-val');
  });
});

test.describe('ctx-kv — wire probes', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/ctx-kv');
    await installRig(page);
  });

  test('kv.list(prefix) returns only keys under that prefix', async ({ page }, testInfo) => {
    const a = await connect(page, {
      path: '/ws/ctx-kv',
      username: 'alice',
      room: `kv-list-${testInfo.testId}`,
    });
    const prefix = `pfx-${testInfo.testId}`;
    await send(page, a, { event: 'kv-list-probe', payload: { prefix } });
    const res = await waitForFrame(page, a, { match: (f) => f.event === 'kv-list-result' });
    const keys = res.payload.keys as string[];
    expect(keys).toContain(`${prefix}:a`);
    expect(keys).toContain(`${prefix}:b`);
    expect(keys).not.toContain('other-prefix:c');
  });

  test('kv.set with ttl:0 stores with no expiry', async ({ page }, testInfo) => {
    const a = await connect(page, {
      path: '/ws/ctx-kv',
      username: 'alice',
      room: `kv-ttl0-${testInfo.testId}`,
    });
    await send(page, a, { event: 'kv-ttl-zero-probe', payload: { key: 'k0', value: 'stays' } });
    const res = await waitForFrame(page, a, { match: (f) => f.event === 'kv-result' });
    expect(res.payload.value).toBe('stays');
  });
});
