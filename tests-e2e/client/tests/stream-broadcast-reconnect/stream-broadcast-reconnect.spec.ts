import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// Proof for one question: can a broadcast stream deliver the same chunk twice
// to one client after that client reconnects? The peer listens with onStream,
// drops its socket in the middle of a recorded broadcast, reconnects, then
// continues the stream by ID. The spec records every chunk each surface gets.
async function open(page: Page, room: string, username: string): Promise<void> {
  await page.goto(`/tests/stream-broadcast-reconnect/index.html?room=${room}&username=${username}`);
  await expect(page.getByTestId('app-ready')).toHaveText('yes');
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('status')).toHaveText('open');
  await page.getByTestId('subscribe').click();

  await expect(page.getByTestId('sub-ok')).toHaveText('yes');
}

function tokens(text: string | null): string[] {
  return text ? text.split(',') : [];
}

test(
  'a broadcast chunk never reaches the same listener twice across a reconnect',
  { tag: '@websocket' },
  async ({ browser }, testInfo) => {
    const room = `sbr-${testInfo.testId}`;
    const trigger = await browser.newContext();
    const peer = await browser.newContext();
    const a = await trigger.newPage();
    const b = await peer.newPage();

    await open(a, room, 'alice');
    await open(b, room, 'bob');
    await b.getByTestId('listen').click();

    await a.getByTestId('start').click();
    await expect(b.getByTestId('peer-chunks')).toHaveText(/t2/);

    await b.getByTestId('drop').click();
    await expect(b.getByTestId('status')).not.toHaveText('open');
    await expect(b.getByTestId('status')).toHaveText('open');

    await b.getByTestId('continue').click();
    await expect(a.getByTestId('trigger-end')).toHaveText('yes');
    await expect(b.getByTestId('continue-end')).toHaveText('yes');
    await b.waitForTimeout(1_000);

    const peerChunks = tokens(await b.getByTestId('peer-chunks').textContent());
    const continueChunks = tokens(await b.getByTestId('continue-chunks').textContent());
    expect(new Set(peerChunks).size).toBe(peerChunks.length);
    expect(new Set(continueChunks).size).toBe(continueChunks.length);

    await trigger.close();
    await peer.close();
  },
);
