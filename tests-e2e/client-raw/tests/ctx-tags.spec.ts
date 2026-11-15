import { expect, test } from '@playwright/test';

test.describe('ctx-tags', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    await page.goto(`/ctx-tags?room=${room}`);
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');
  });

  test('tag and untag self', async ({ page }) => {
    await page.getByTestId('tag-vip').click();
    await expect(page.getByTestId('tags')).toContainText('vip');

    await page.getByTestId('untag-vip').click();
    await expect(page.getByTestId('tags')).not.toContainText('vip');
  });

  test('ctx.connections.all() returns a count for the current DO', async ({ page }) => {
    await page.getByTestId('conn-info').click();
    await expect(page.getByTestId('conn-count')).toHaveText(/[1-9]\d*/);
  });

  test('tag ref connections() returns self', async ({ page }) => {
    // onAuthenticate tags this connection with its username; so the username tag
    // should match exactly this one connection.
    await page.getByTestId('get-by-username').click();
    await expect(page.getByTestId('by-tag')).toHaveText(/testuser:[1-9]\d*/);
  });

  test('untag of non-existent tag is a no-op', async ({ page }) => {
    // onAuthenticate already tagged this connection with its username, so 'tags'
    // is non-empty from the start. Untagging 'vip' (which was never set)
    // must not remove the username tag and must not crash the pipeline.
    await page.getByTestId('untag-vip').click();
    await expect(page.getByTestId('tags')).not.toContainText('vip');
    await expect(page.getByTestId('tags')).toContainText('testuser');

    // Positive signal: the connection still accepts new tags after the no-op.
    await page.getByTestId('tag-vip').click();
    await expect(page.getByTestId('tags')).toContainText('vip');
  });

  test('multiple tags on same connection', async ({ page }) => {
    await page.getByTestId('tag-vip').click();
    await expect(page.getByTestId('tags')).toContainText('vip');

    // Tag again with a different tag.
    await page.evaluate(() => {
      const ws = (window as unknown as { __ws?: WebSocket }).__ws;
      ws?.send(window.__livethingEncode({ event: 'tag-self', payload: { tag: 'premium' } }));
    });
    await expect(page.getByTestId('tags')).toContainText('vip');
    await expect(page.getByTestId('tags')).toContainText('premium');
  });

  test('tag persists across multiple messages', async ({ page }) => {
    await page.getByTestId('tag-vip').click();
    await expect(page.getByTestId('tags')).toContainText('vip');

    // Send another message and verify tag is still there.
    await page.getByTestId('conn-info').click();
    await expect(page.getByTestId('conn-count')).toHaveText(/[1-9]\d*/);

    // Verify tag is still present.
    await page.getByTestId('get-by-username').click();
    await expect(page.getByTestId('by-tag')).toHaveText(/testuser:\d+/);
  });

  test('getConnectionsByTag returns peers too (multi-client scenario)', async ({
    browser,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    await page1.goto(`/ctx-tags?room=${room}`);
    await page2.goto(`/ctx-tags?room=${room}`);

    // Both connect.
    await page1.getByTestId('connect').click();
    await page2.getByTestId('connect').click();
    await expect(page1.getByTestId('status')).toHaveText('connected');
    await expect(page2.getByTestId('status')).toHaveText('connected');

    // Both tag themselves with 'crew'. Wait for each page's tag-result to
    // confirm the tag has been applied on the DO side before continuing —
    // otherwise page1's query below could race ahead of page2's write.
    await page1.evaluate(() => {
      const ws = (window as unknown as { __ws?: WebSocket }).__ws;
      ws?.send(window.__livethingEncode({ event: 'tag-self', payload: { tag: 'crew' } }));
    });
    await expect(page1.getByTestId('tags')).toContainText('crew');
    await page2.evaluate(() => {
      const ws = (window as unknown as { __ws?: WebSocket }).__ws;
      ws?.send(window.__livethingEncode({ event: 'tag-self', payload: { tag: 'crew' } }));
    });
    await expect(page2.getByTestId('tags')).toContainText('crew');

    // Page1 queries for 'crew' tag and expects to see at least 2 connections.
    await page1.evaluate(() => {
      const ws = (window as unknown as { __ws?: WebSocket }).__ws;
      ws?.send(window.__livethingEncode({ event: 'get-by-tag', payload: { tag: 'crew' } }));
    });

    await expect(page1.getByTestId('by-tag')).toHaveText(/crew:[2-9]\d*/);

    await ctx1.close();
    await ctx2.close();
  });

  test('connectionCount matches actual live connections', async ({ page }) => {
    await page.getByTestId('conn-info').click();
    await expect(page.getByTestId('conn-count')).toHaveText('1');
  });

  test(
    'connectionCount in multi-client scenario',
    { tag: '@drop' },
    async ({ browser }, testInfo) => {
      // Use a distinct room so the beforeEach's default `page` (which also
      // connects) doesn't count against this test's DO.
      const room = `multi-${testInfo.testId}`;
      const ctx1 = await browser.newContext();
      const ctx2 = await browser.newContext();
      const page1 = await ctx1.newPage();
      const page2 = await ctx2.newPage();

      await page1.goto(`/ctx-tags?room=${room}`);
      await page2.goto(`/ctx-tags?room=${room}`);

      await page1.getByTestId('connect').click();
      await expect(page1.getByTestId('status')).toHaveText('connected');
      await page1.getByTestId('conn-info').click();
      await expect(page1.getByTestId('conn-count')).toHaveText('1');

      await page2.getByTestId('connect').click();
      await expect(page2.getByTestId('status')).toHaveText('connected');
      await page1.getByTestId('conn-info').click();
      await expect(page1.getByTestId('conn-count')).toHaveText('2');

      await ctx2.close();
      // Give the server event loop a moment to observe the close before polling.
      // Playwright's toHaveText already polls with a default of 5s; bump to 10s
      // since miniflare's disconnect propagation under parallel load can be slow.
      await expect(async () => {
        await page1.getByTestId('conn-info').click();
        await expect(page1.getByTestId('conn-count')).toHaveText('1');
      }).toPass({ timeout: 10_000 });

      await ctx1.close();
    },
  );
});
