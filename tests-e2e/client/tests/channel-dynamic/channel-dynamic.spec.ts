import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// Conformance: @wskit/client's channels() dynamic-family surface against the real
// wskit `channel-dynamic` server definition. Adapter-oblivious — it talks to whatever
// server the run booted over the /ws proxy.
async function open(page: Page, room: string, username = 'alice'): Promise<void> {
  await page.goto(`/tests/channel-dynamic/index.html?room=${room}&username=${username}`);
  await expect(page.getByTestId('app-ready')).toHaveText('yes');
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('status')).toHaveText('open');
}

test.describe('channel-dynamic (conformance)', () => {
  test('subscribe() waits for a lazy connection to open before sending', async ({
    page,
  }, testInfo) => {
    await page.goto(
      `/tests/channel-dynamic/index.html?room=cd-lazy-${testInfo.testId}&username=alice&lazy=true&probe=lazy`,
    );
    await expect(page.getByTestId('app-ready')).toHaveText('yes');

    await page.getByTestId('sub-general').click();

    await expect(page.getByTestId('status')).toHaveText('open');
    await expect(page.getByTestId('sub-general-ok')).toHaveText('room:general');
  });

  test('a channel message error keeps an active lazy subscription open', async ({
    page,
  }, testInfo) => {
    await page.goto(
      `/tests/channel-dynamic/index.html?room=cd-error-${testInfo.testId}&username=alice&lazy=true&probe=hold`,
    );
    await expect(page.getByTestId('app-ready')).toHaveText('yes');
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('open');
    await page.getByTestId('sub-general').click();

    await expect(page.getByTestId('sub-general-ok')).toHaveText('room:general');

    await page.getByTestId('fail-general').click();
    await expect(page.getByTestId('subscription-failed')).toHaveText('yes');
    await page.waitForTimeout(650);

    await expect(page.getByTestId('status')).toHaveText('open');
  });

  test('subscribe() to a name matching the family resolves', async ({ page }, testInfo) => {
    await open(page, `cd-join-${testInfo.testId}`);
    await page.getByTestId('sub-general').click();
    await expect(page.getByTestId('sub-general-ok')).toHaveText('room:general');
  });

  test('socket.channel.family(familyKey) handle subscribes to a family member', async ({
    page,
  }, testInfo) => {
    await open(page, `cd-scope-${testInfo.testId}`);
    await page.getByTestId('sub-via-scope').click();
    await expect(page.getByTestId('sub-via-scope-ok')).toHaveText('room:general');
  });

  test('a name failing the family regex rejects with channel-not-found', async ({
    page,
  }, testInfo) => {
    await open(page, `cd-badname-${testInfo.testId}`);
    await page.getByTestId('sub-bad-name').click();
    await expect(page.getByTestId('sub-error')).toHaveText('channel-not-found');
  });

  test('a scoped send round-trips to the sender after subscribe', async ({ page }, testInfo) => {
    await open(page, `cd-echo-${testInfo.testId}`);
    await page.getByTestId('sub-general').click();
    await expect(page.getByTestId('sub-general-ok')).toHaveText('room:general');
    await page.getByTestId('echo-general').click();
    await expect(page.getByTestId('name-result')).toHaveText('room:general|general');
  });

  test('two clients on the same dynamic name share a broadcast group', async ({
    browser,
  }, testInfo) => {
    const room = `cd-group-${testInfo.testId}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();

    await open(a, room, 'alice');
    await open(b, room, 'bob');

    await a.getByTestId('sub-general').click();
    await b.getByTestId('sub-general').click();
    await expect(a.getByTestId('sub-general-ok')).toHaveText('room:general');
    await expect(b.getByTestId('sub-general-ok')).toHaveText('room:general');

    await a.getByTestId('send-general').click();
    await expect(b.getByTestId('user-msgs-general')).toContainText('alice:hello-general');

    await b.getByTestId('send-general').click();
    await expect(a.getByTestId('user-msgs-general')).toContainText('bob:hello-general');

    await ctxA.close();
    await ctxB.close();
  });

  test('dynamic names with different suffixes stay isolated', async ({ browser }, testInfo) => {
    const room = `cd-isolated-${testInfo.testId}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();

    await open(a, room, 'alice');
    await open(b, room, 'bob');

    // Bob is on both channels so he is the positive-signal receiver for either
    // side. Alice is only on general.
    await a.getByTestId('sub-general').click();
    await b.getByTestId('sub-general').click();
    await b.getByTestId('sub-vip').click();
    await expect(a.getByTestId('sub-general-ok')).toHaveText('room:general');
    await expect(b.getByTestId('sub-general-ok')).toHaveText('room:general');

    await expect(b.getByTestId('sub-vip-ok')).toHaveText('room:vip');

    // Alice publishes to general. Bob (on both) must see it on general — that
    // receipt is the positive signal. Bob's vip bucket must stay empty, proving
    // dynamic-name isolation.
    await a.getByTestId('send-general').click();
    await expect(b.getByTestId('user-msgs-general')).toContainText('alice:hello-general');
    await expect(b.getByTestId('user-msgs-vip')).toHaveText('');

    await ctxA.close();
    await ctxB.close();
  });
});
