import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// Conformance: @wskit/client's stream() / onStream() against the real wskit
// `stream-broadcast` handler. Adapter-oblivious — it talks to whatever server
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

  // NOTE: a channel-scoped broadcast (the 'rooms' scope('rooms','room:{id}')
  // family) is not covered here — InferClient collapses that dynamic family into
  // a fixed channel, so the typed client can't address it (same gap worked around
  // in channel-dynamic). Top-level broadcast fan-out + terminal error are proven
  // above; channel membership scoping is proven in channel-static.
});
