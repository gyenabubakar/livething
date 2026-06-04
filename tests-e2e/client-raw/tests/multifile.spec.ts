import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// Coverage: a handler split across setup.ts + rooms.ts + handler.ts must work
// end-to-end. The notification comes from a flat .onConnect in handler.ts; the
// room channel is defined in rooms.ts; the shared base lives in setup.ts. If
// type state or primitives didn't survive the file boundary, one of these
// would silently fail.
test.describe('multifile', () => {
  async function openPage(page: Page, room: string, username = 'alice') {
    await page.goto(`/multifile?room=${room}`);
    await page.getByTestId('username').fill(username);
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected', { timeout: 15_000 });
  }

  test('notification from onConnect (flat handler defined in handler.ts) arrives', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await expect(page.getByTestId('notifications')).toContainText('welcome alice');
  });

  test('channel defined in rooms.ts dispatches and broadcasts correctly', async ({
    browser,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const a = await (await browser.newContext()).newPage();
    const b = await (await browser.newContext()).newPage();

    await a.goto(`/multifile?room=${room}`);
    await a.getByTestId('username').fill('alice');
    await a.getByTestId('connect').click();
    await expect(a.getByTestId('status')).toHaveText('connected', { timeout: 15_000 });
    await a.getByTestId('subscribe').click();
    await expect(a.getByTestId('subscribed')).toHaveText('yes');

    await b.goto(`/multifile?room=${room}`);
    await b.getByTestId('username').fill('bob');
    await b.getByTestId('connect').click();
    await expect(b.getByTestId('status')).toHaveText('connected', { timeout: 15_000 });
    await b.getByTestId('subscribe').click();
    await expect(b.getByTestId('subscribed')).toHaveText('yes');

    await a.getByTestId('send-hello').click();

    // Sender (alice) is excluded from `ctx.channel.broadcast` by default.
    // Bob receives it — proves channel + ctx.meta.username (typed in setup.ts,
    // used in rooms.ts) survived composition.
    await expect(b.getByTestId('room-messages')).toContainText('alice:hello');
  });
});
