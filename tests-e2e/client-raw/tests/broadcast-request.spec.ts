import { expect, test } from '@playwright/test';

// Phase 3: broadcast request (first answer wins) over the real wire. Two clients
// join the same `lobby` channel; the server fans `volunteer` out to both and
// resolves with the first valid answer plus the answerer's identity (`from`).
test.describe('broadcast request — first answer wins', () => {
  test('the lone valid answerer wins and is reported as from', async ({ browser }) => {
    const room = `bcast-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    // alice answers the broadcast; bob stays silent (drop).
    await pageA.goto(`/broadcast-request?room=${room}`);
    await pageA.getByTestId('username').fill('alice');
    await pageB.goto(`/broadcast-request?room=${room}`);
    await pageB.getByTestId('username').fill('bob');

    for (const page of [pageA, pageB]) {
      await page.getByTestId('connect').click();
      await expect(page.getByTestId('status')).toHaveText('connected');
      await page.getByTestId('subscribe').click();
      await expect(page.getByTestId('subscribed')).toHaveText('true');
    }

    await pageA.getByTestId('answer-good').click();
    await pageB.getByTestId('answer-drop').click();

    // alice triggers the broadcast; alice is the only one who answers.
    await pageA.getByTestId('trigger').click();

    // Both members were asked the question...
    await expect(pageA.getByTestId('last-turn')).toHaveText('5');
    await expect(pageB.getByTestId('last-turn')).toHaveText('5');
    // ...and the server resolved with alice's answer and identity.
    await expect(pageA.getByTestId('outcome-from')).toHaveText('alice');
    await expect(pageA.getByTestId('outcome-ready')).toHaveText('true');

    await ctxA.close();
    await ctxB.close();
  });

  test('an invalid answer never beats a valid one', async ({ browser }) => {
    const room = `bcast-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    await pageA.goto(`/broadcast-request?room=${room}`);
    await pageA.getByTestId('username').fill('alice');
    await pageB.goto(`/broadcast-request?room=${room}`);
    await pageB.getByTestId('username').fill('bob');

    for (const page of [pageA, pageB]) {
      await page.getByTestId('connect').click();
      await expect(page.getByTestId('status')).toHaveText('connected');
      await page.getByTestId('subscribe').click();
      await expect(page.getByTestId('subscribed')).toHaveText('true');
    }

    // bob answers with a schema-violating payload (dropped, never a win);
    // alice answers validly and so must win.
    await pageA.getByTestId('answer-good').click();
    await pageB.getByTestId('answer-bad').click();

    await pageA.getByTestId('trigger').click();

    await expect(pageA.getByTestId('outcome-from')).toHaveText('alice');
    await expect(pageA.getByTestId('outcome-ready')).toHaveText('true');

    await ctxA.close();
    await ctxB.close();
  });

  test('nobody answers before the timeout → timeout', async ({ browser }) => {
    const room = `bcast-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    await pageA.goto(`/broadcast-request?room=${room}`);
    await pageA.getByTestId('username').fill('alice');
    await pageB.goto(`/broadcast-request?room=${room}`);
    await pageB.getByTestId('username').fill('bob');

    for (const page of [pageA, pageB]) {
      await page.getByTestId('connect').click();
      await expect(page.getByTestId('status')).toHaveText('connected');
      await page.getByTestId('subscribe').click();
      await expect(page.getByTestId('subscribed')).toHaveText('true');
    }

    // Both members stay silent — the broadcast must time out.
    await pageA.getByTestId('answer-drop').click();
    await pageB.getByTestId('answer-drop').click();

    await pageA.getByTestId('trigger-timeout').click();

    await expect(pageA.getByTestId('last-turn')).toHaveText('9');
    await expect(pageB.getByTestId('last-turn')).toHaveText('9');
    await expect(pageA.getByTestId('error-outcome')).toHaveText('timeout');

    await ctxA.close();
    await ctxB.close();
  });
});
