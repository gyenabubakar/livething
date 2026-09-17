import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// Conformance: @wskit/client's stream() / onStream() against the real wskit
// `stream-broadcast` server definition. Adapter-oblivious — it talks to whatever server
// the run booted over the /ws proxy. Broadcast fan-out needs a second client,
// so each test opens a peer in its own browser context on the same room.
async function open(page: Page, room: string, username: string): Promise<void> {
  await page.goto(`/tests/stream-broadcast/index.html?room=${room}&username=${username}`);
  await expect(page.getByTestId('app-ready')).toHaveText('yes');
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('status')).toHaveText('open');
}

test.describe('stream-broadcast (conformance)', () => {
  test('onStream listener receives every broadcast chunk then onEnd', async ({
    browser,
  }, testInfo) => {
    const room = `sb-fanout-${testInfo.testId}`;
    const trigger = await browser.newContext();
    const peer = await browser.newContext();
    const a = await trigger.newPage();
    const b = await peer.newPage();

    await open(a, room, 'alice');
    await open(b, room, 'bob');

    await b.getByTestId('listen').click();

    await a.getByTestId('start-3').click();
    await expect(a.getByTestId('trigger-chunks')).toHaveText('0,1,2');
    await expect(a.getByTestId('trigger-end')).toHaveText('yes');

    await expect(b.getByTestId('peer-chunks')).toHaveText('0,1,2');
    await expect(b.getByTestId('peer-end')).toHaveText('yes');

    await trigger.close();
    await peer.close();
  });

  test('a creator-generator error fans a terminal error to the peer onError', async ({
    browser,
  }, testInfo) => {
    const room = `sb-boom-${testInfo.testId}`;
    const trigger = await browser.newContext();
    const peer = await browser.newContext();
    const a = await trigger.newPage();
    const b = await peer.newPage();

    await open(a, room, 'alice');
    await open(b, room, 'bob');

    await b.getByTestId('listen').click();

    await a.getByTestId('start-boom').click();
    await expect(a.getByTestId('trigger-chunks')).toHaveText('0');
    await expect(a.getByTestId('trigger-error')).not.toHaveText('');

    await expect(b.getByTestId('peer-chunks')).toHaveText('0');
    await expect(b.getByTestId('peer-error')).not.toHaveText('');

    await trigger.close();
    await peer.close();
  });

  test('a channel-scoped broadcast fans out to a subscribed peer in the same room', async ({
    browser,
  }, testInfo) => {
    const room = `sb-room-${testInfo.testId}`;
    const trigger = await browser.newContext();
    const peer = await browser.newContext();
    const a = await trigger.newPage();
    const b = await peer.newPage();

    await open(a, room, 'alice');
    await open(b, room, 'bob');

    // Both join the same concrete channel in the dynamic 'rooms' family.
    await a.getByTestId('sub-room').click();
    await expect(a.getByTestId('room-sub-ok')).toHaveText('yes');
    await b.getByTestId('sub-room').click();
    await expect(b.getByTestId('room-sub-ok')).toHaveText('yes');

    await b.getByTestId('listen-room').click();

    await a.getByTestId('start-room-3').click();
    await expect(a.getByTestId('room-trigger-chunks')).toHaveText('0,1,2');
    await expect(a.getByTestId('room-trigger-end')).toHaveText('yes');

    await expect(b.getByTestId('room-peer-chunks')).toHaveText('0,1,2');
    await expect(b.getByTestId('room-peer-end')).toHaveText('yes');

    await trigger.close();
    await peer.close();
  });
});
