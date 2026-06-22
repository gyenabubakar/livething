import { expect, test } from '@playwright/test';

test.describe('stream-broadcast', () => {
  test('broadcast stream reaches trigger connection and every peer', async ({
    browser,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();
    await a.goto(`/stream-broadcast?room=${room}`);
    await b.goto(`/stream-broadcast?room=${room}`);
    await a.getByTestId('username').fill('alice');
    await b.getByTestId('username').fill('bob');
    await a.getByTestId('connect').click();
    await b.getByTestId('connect').click();
    await expect(a.getByTestId('status')).toHaveText('connected', { timeout: 15_000 });
    await expect(b.getByTestId('status')).toHaveText('connected', { timeout: 15_000 });

    // broadcast() fans each chunk to peers while the trigger still receives
    // its normal per-stream copy.
    await a.getByTestId('start-3').click();
    await expect(a.getByTestId('stream-end')).toHaveText('yes');
    await expect(a.getByTestId('indices')).toHaveText('0,1,2');
    await expect(b.getByTestId('indices')).toContainText('0');
    await expect(b.getByTestId('indices')).toContainText('1');
    await expect(b.getByTestId('indices')).toContainText('2');

    await ctxA.close();
    await ctxB.close();
  });

  test('broadcast stream inside a dynamic channel family carries _channelFamily on peer chunks', async ({
    browser,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();

    await a.goto(`/stream-broadcast?room=${room}`);
    await b.goto(`/stream-broadcast?room=${room}`);
    await a.getByTestId('username').fill('alice');
    await b.getByTestId('username').fill('bob');
    await a.getByTestId('connect').click();
    await b.getByTestId('connect').click();
    await expect(a.getByTestId('status')).toHaveText('connected', { timeout: 15_000 });
    await expect(b.getByTestId('status')).toHaveText('connected', { timeout: 15_000 });

    // Both clients subscribe to the same room before the stream runs so
    // peer broadcast hits an actual channel member.
    await a.getByTestId('join-room').click();
    await b.getByTestId('join-room').click();
    await expect(a.getByTestId('room-subscribed')).toHaveText('yes');
    await expect(b.getByTestId('room-subscribed')).toHaveText('yes');

    // Trigger the broadcast stream from alice. Pre-fix, the peer (bob)
    // never received chunks because the engine rejected them as undeclared
    // (channelFamily dropped from broadcast options) — or received them
    // without _channelFamily so the page filter skipped them.
    await a.getByTestId('start-room-3').click();
    await expect(a.getByTestId('room-stream-end')).toHaveText('yes');
    await expect(a.getByTestId('room-indices')).toHaveText('0,1,2');

    // Peer received every chunk AND the chunks carried _channelFamily so the
    // client could attribute them to the 'rooms' family.
    await expect(b.getByTestId('room-indices')).toHaveText('0,1,2');
    await expect(b.getByTestId('room-scope-seen')).toHaveText('rooms');

    await ctxA.close();
    await ctxB.close();
  });

  test('channel-scoped broadcast stream chunks do not reach non-members', async ({
    browser,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const ctxM = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();
    const mallory = await ctxM.newPage();

    await a.goto(`/stream-broadcast?room=${room}`);
    await b.goto(`/stream-broadcast?room=${room}`);
    await mallory.goto(`/stream-broadcast?room=${room}`);
    await a.getByTestId('username').fill('alice');
    await b.getByTestId('username').fill('bob');
    await mallory.getByTestId('username').fill('mallory');
    await a.getByTestId('connect').click();
    await b.getByTestId('connect').click();
    await mallory.getByTestId('connect').click();
    await expect(a.getByTestId('status')).toHaveText('connected', { timeout: 15_000 });
    await expect(b.getByTestId('status')).toHaveText('connected', { timeout: 15_000 });
    await expect(mallory.getByTestId('status')).toHaveText('connected', { timeout: 15_000 });

    // Alice and Bob subscribe; Mallory connects but never subscribes.
    await a.getByTestId('join-room').click();
    await b.getByTestId('join-room').click();
    await expect(a.getByTestId('room-subscribed')).toHaveText('yes');
    await expect(b.getByTestId('room-subscribed')).toHaveText('yes');

    await a.getByTestId('start-room-3').click();
    await expect(a.getByTestId('room-stream-end')).toHaveText('yes');
    await expect(a.getByTestId('room-indices')).toHaveText('0,1,2');
    await expect(b.getByTestId('room-indices')).toHaveText('0,1,2');

    // Mallory is still connected. Wait long enough for chunks to have
    // arrived if the membership filter was off, then assert empty.
    await mallory.waitForTimeout(2000);
    expect(await mallory.getByTestId('room-indices').textContent()).toBe('');
    expect(await mallory.getByTestId('room-stream-end').textContent()).toBe('no');

    await ctxA.close();
    await ctxB.close();
    await ctxM.close();
  });

  test('trigger receives each chunk once while peers still receive the broadcast', async ({
    browser,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();

    await a.goto(`/stream-broadcast?room=${room}`);
    await b.goto(`/stream-broadcast?room=${room}`);
    await a.getByTestId('connect').click();
    await b.getByTestId('connect').click();
    // Longer wait: under full-suite load the handshake to the shared worker can
    // take more than the default 5s.
    await expect(a.getByTestId('status')).toHaveText('connected', { timeout: 15_000 });
    await expect(b.getByTestId('status')).toHaveText('connected', { timeout: 15_000 });

    await a.getByTestId('start-3').click();
    await expect(a.getByTestId('stream-end')).toHaveText('yes');

    await expect(a.getByTestId('indices')).toHaveText('0,1,2');
    await expect(b.getByTestId('indices')).toHaveText('0,1,2');

    await ctxA.close();
    await ctxB.close();
  });
});
