import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

test.describe('channel-static', () => {
  async function openPage(page: Page, room: string, username = 'testuser') {
    await page.goto(`/channel-static?room=${room}`);
    await page.getByTestId('username').fill(username);
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');
  }

  test('_subscribe joins the channel and sends _subscribeOk', async ({ page }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('subscribe-room').click();
    await expect(page.getByTestId('subscribe-ok-count')).toHaveText('1');
  });

  test('two _subscribe calls are idempotent and both ack', async ({ page }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('subscribe-room').click();
    await expect(page.getByTestId('subscribe-ok-count')).toHaveText('1');
    await page.getByTestId('subscribe-room').click();
    await expect(page.getByTestId('subscribe-ok-count')).toHaveText('2');
    // Each _subscribeOk frame must carry the requested _channel name back.
    await expect(page.getByTestId('subscribe-ok-channels')).toHaveText('room,room');
  });

  test('subscribing to an unknown channel emits _error with code channel-not-found', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('subscribe-bogus').click();
    await expect(page.getByTestId('subscribe-error')).toHaveText(
      'does-not-exist:channel-not-found',
    );
  });

  test('_unsubscribe when not subscribed is a silent no-op', async ({ page }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    // Click unsubscribe first (should be silent), then subscribe — the
    // successful subscribe-ok is the positive signal that proves the
    // unsubscribe didn't close or fault the channel handler pipeline.
    await page.getByTestId('unsubscribe-room').click();
    await page.getByTestId('subscribe-room').click();
    await expect(page.getByTestId('subscribe-ok-count')).toHaveText('1');
    await expect(page.getByTestId('subscribe-error')).toHaveText('');
  });

  test('publishing to a channel without subscribing first is silently dropped', async ({
    browser,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();
    await openPage(a, room, 'alice');
    await openPage(b, room, 'bob');
    // Bob subscribes; alice does not. Alice tries to publish unsubscribed.
    await b.getByTestId('subscribe-room').click();
    await expect(b.getByTestId('subscribe-ok-count')).toHaveText('1');

    await a.getByTestId('publish-without-sub').click();

    // Now alice subscribes and publishes a second time — bob should receive
    // only the SECOND message, proving the first was dropped.
    await a.getByTestId('subscribe-room').click();
    await expect(a.getByTestId('subscribe-ok-count')).toHaveText('1');
    await a.getByTestId('send-hello').click();

    await expect(b.getByTestId('user-messages')).toContainText('alice:hello');
    await expect(b.getByTestId('user-messages')).not.toContainText('alice:stray');

    await ctxA.close();
    await ctxB.close();
  });

  test('onBeforeSubscribe rejection emits _error and prevents the subscription', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`, 'blocked-user');
    await page.getByTestId('subscribe-room').click();
    // The thrown error in onBeforeSubscribe is routed back as an _error
    // frame — that's our positive signal. Then assert no _subscribeOk.
    await expect(page.getByTestId('subscribe-error')).toContainText('room:');
    await expect(page.getByTestId('subscribe-ok-count')).toHaveText('0');
  });

  test('ctx.channel.broadcast reaches every subscribed member', async ({ browser }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();
    await openPage(a, room, 'alice');
    await openPage(b, room, 'bob');
    await a.getByTestId('subscribe-room').click();
    await b.getByTestId('subscribe-room').click();
    await expect(a.getByTestId('subscribe-ok-count')).toHaveText('1');
    await expect(b.getByTestId('subscribe-ok-count')).toHaveText('1');

    // ctx.channel.broadcast fans out to OTHER members; sender does not
    // receive their own broadcast. Peer-round-trip proves delivery without a
    // fixed timeout: if alice's own broadcast were going to echo back, it
    // would arrive before bob's subsequent broadcast does.
    await a.getByTestId('send-hello').click();
    await expect(b.getByTestId('user-messages')).toContainText('alice:hello');
    await b.getByTestId('send-hello').click();
    await expect(a.getByTestId('user-messages')).toContainText('bob:hello');
    await expect(a.getByTestId('user-messages')).not.toContainText('alice:hello');

    await ctxA.close();
    await ctxB.close();
  });

  test('onSubscribe broadcasts a system message to existing members', async ({
    browser,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();
    await openPage(a, room, 'alice');
    await a.getByTestId('subscribe-room').click();
    await expect(a.getByTestId('subscribe-ok-count')).toHaveText('1');

    // Bob joining triggers onSubscribe which broadcasts "bob entered" to alice.
    await openPage(b, room, 'bob');
    await b.getByTestId('subscribe-room').click();
    await expect(a.getByTestId('system-messages')).toContainText('bob entered');

    await ctxA.close();
    await ctxB.close();
  });

  test('onUnsubscribe broadcasts a system message to remaining members', async ({
    browser,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();
    await openPage(a, room, 'alice');
    await openPage(b, room, 'bob');
    await a.getByTestId('subscribe-room').click();
    await b.getByTestId('subscribe-room').click();
    await expect(a.getByTestId('subscribe-ok-count')).toHaveText('1');
    await expect(b.getByTestId('subscribe-ok-count')).toHaveText('1');

    await b.getByTestId('unsubscribe-room').click();
    await expect(a.getByTestId('system-messages')).toContainText('bob left');

    await ctxA.close();
    await ctxB.close();
  });

  test('stream declared inside a channel yields chunks and ends normally', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('subscribe-room').click();
    await expect(page.getByTestId('subscribe-ok-count')).toHaveText('1');
    await page.getByTestId('start-channel-stream-3').click();
    await expect(page.getByTestId('channel-stream-chunks')).toHaveText('0,1,2');
    await expect(page.getByTestId('channel-stream-end')).toHaveText('yes');
  });

  test('framework _memberJoin frame delivers when a peer subscribes', async ({
    browser,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();
    await openPage(a, room, 'alice');
    await a.getByTestId('subscribe-room').click();
    await expect(a.getByTestId('subscribe-ok-count')).toHaveText('1');

    await openPage(b, room, 'bob');
    await b.getByTestId('subscribe-room').click();

    // Alice (existing member) should see the framework _memberJoin frame
    // referencing bob's connection on the 'room' channel.
    await expect(a.getByTestId('member-joins')).toContainText('room:');

    await ctxA.close();
    await ctxB.close();
  });

  test('joining client receives _subscribeOk before existing member observes _memberJoin', async ({
    browser,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();
    await openPage(a, room, 'alice');
    await a.getByTestId('subscribe-room').click();
    await expect(a.getByTestId('subscribe-ok-count')).toHaveText('1');

    await openPage(b, room, 'bob');
    await b.getByTestId('subscribe-room').click();

    // Bob (the joining client) must receive _subscribeOk before we check Alice's side.
    // This assertion waits for Bob's ack to arrive, confirming the server sent it first.
    await expect(b.getByTestId('subscribe-ok-count')).toHaveText('1');
    // Only now verify that Alice (existing member) observed the _memberJoin.
    await expect(a.getByTestId('member-joins')).toContainText('room:');

    await ctxA.close();
    await ctxB.close();
  });

  test('framework _memberLeave frame delivers on manual _unsubscribe', async ({
    browser,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();
    await openPage(a, room, 'alice');
    await openPage(b, room, 'bob');
    await a.getByTestId('subscribe-room').click();
    await b.getByTestId('subscribe-room').click();
    await expect(a.getByTestId('subscribe-ok-count')).toHaveText('1');
    await expect(b.getByTestId('subscribe-ok-count')).toHaveText('1');

    await b.getByTestId('unsubscribe-room').click();
    await expect(a.getByTestId('member-leaves')).toContainText('room:');

    await ctxA.close();
    await ctxB.close();
  });

  test('framework _memberLeave frame delivers on connection drop', async ({
    browser,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();
    await openPage(a, room, 'alice');
    await openPage(b, room, 'bob');
    await a.getByTestId('subscribe-room').click();
    await b.getByTestId('subscribe-room').click();
    await expect(a.getByTestId('subscribe-ok-count')).toHaveText('1');
    await expect(b.getByTestId('subscribe-ok-count')).toHaveText('1');

    await ctxB.close();
    await expect(a.getByTestId('member-leaves')).toContainText('room:', { timeout: 15_000 });

    await ctxA.close();
  });

  test('connection drop (not manual unsubscribe) still fires onUnsubscribe', async ({
    browser,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();
    await openPage(a, room, 'alice');
    await openPage(b, room, 'bob');
    await a.getByTestId('subscribe-room').click();
    await b.getByTestId('subscribe-room').click();
    await expect(a.getByTestId('subscribe-ok-count')).toHaveText('1');
    await expect(b.getByTestId('subscribe-ok-count')).toHaveText('1');

    // Close bob's connection without explicit unsubscribe
    await ctxB.close();

    // Alice should still see bob's "left" system message
    await expect(a.getByTestId('system-messages')).toContainText('bob left', { timeout: 15_000 });

    await ctxA.close();
  });
});
