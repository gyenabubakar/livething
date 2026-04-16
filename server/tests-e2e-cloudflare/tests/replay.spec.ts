import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

function waitForText(page: Page, testId: string, expected: string | RegExp, timeout = 10_000) {
  return expect(page.getByTestId(testId)).toHaveText(expected, { timeout });
}

test.describe('replay handler', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/replay');
    await expect(page.getByTestId('status')).toHaveText('disconnected');
    await page.getByTestId('connect-btn').click();
    await waitForText(page, 'status', 'connected');
  });

  test('sends and receives messages', async ({ page }) => {
    await page.getByTestId('send-msg-btn').click();
    await waitForText(page, 'messages', /testuser: hello from replay/);
  });

  test('sequence numbers present', async ({ page }) => {
    await page.getByTestId('send-msg-btn').click();
    await waitForText(page, 'messages', /hello from replay/);
    const seq = await page.getByTestId('last-seq').textContent();
    expect(Number(seq)).toBeGreaterThan(0);
  });

  test('replay returns stored messages after sending', async ({ page }) => {
    await page.getByTestId('send-msg-btn').click();
    await waitForText(page, 'messages', /hello from replay/);

    const beforeCount = (await page.getByTestId('messages').textContent())!.split(' | ').length;
    await page.getByTestId('replay-btn').click();
    await page.waitForTimeout(500);
    const afterCount = (await page.getByTestId('messages').textContent())!.split(' | ').length;
    expect(afterCount).toBeGreaterThan(beforeCount);
  });

  test('excluded events not replayed (cursor excluded)', async ({ page }) => {
    await page.getByTestId('send-cursor-btn').click();
    await waitForText(page, 'cursor-events', /100,200/);

    await page.getByTestId('send-msg-btn').click();
    await waitForText(page, 'messages', /hello from replay/);

    const cursorCountBefore = (await page.getByTestId('cursor-events').textContent())!.split(
      ' | ',
    ).length;
    await page.getByTestId('replay-btn').click();
    await page.waitForTimeout(500);

    const messagesAfter = await page.getByTestId('messages').textContent();
    expect(messagesAfter).toContain('hello from replay');

    const cursorCountAfter = (await page.getByTestId('cursor-events').textContent())!.split(
      ' | ',
    ).length;
    expect(cursorCountAfter).toBe(cursorCountBefore);
  });

  test('channel-scoped replay returns only channel messages', async ({ page }) => {
    await page.getByTestId('room-join-btn').click();
    await waitForText(page, 'room-subscribed', 'subscribed');

    await page.getByTestId('send-msg-btn').click();
    await waitForText(page, 'messages', /hello from replay/);

    await page.getByTestId('room-send-btn').click();
    await waitForText(page, 'room-messages', /room hello/);

    await page.getByTestId('room-replay-btn').click();
    await page.waitForTimeout(500);

    const roomReplayCount = Number(await page.getByTestId('room-replay-count').textContent());
    expect(roomReplayCount).toBeGreaterThan(0);
  });

  test('programmatic sendReplay delivers message', async ({ page }) => {
    await page.getByTestId('request-history-btn').click();
    await waitForText(page, 'history-injected', 'true');
  });

  test('channel sendReplay delivers message in channel scope', async ({ page }) => {
    await page.getByTestId('room-join-btn').click();
    await waitForText(page, 'room-subscribed', 'subscribed');
    await page.getByTestId('request-room-history-btn').click();
    await waitForText(page, 'room-history-injected', 'true');
  });

  test('sequence persistence across reconnection', async ({ page }) => {
    await page.getByTestId('send-msg-btn').click();
    await waitForText(page, 'messages', /hello from replay/);
    await page.getByTestId('send-msg-btn').click();
    await waitForText(page, 'messages', /hello from replay/);
    await page.getByTestId('send-msg-btn').click();
    await waitForText(page, 'messages', /hello from replay/);
    const oldSeq = Number(await page.getByTestId('last-seq').textContent());
    expect(oldSeq).toBeGreaterThan(0);

    await page.getByTestId('disconnect-btn').click();
    await waitForText(page, 'status', 'disconnected');
    await page.getByTestId('connect-btn').click();
    await waitForText(page, 'status', 'connected');

    await page.getByTestId('send-msg-btn').click();
    await waitForText(page, 'messages', /hello from replay/);
    const newSeq = Number(await page.getByTestId('last-seq').textContent());
    expect(newSeq).toBeGreaterThan(oldSeq);
  });

  test('replay from nonzero since', async ({ page }) => {
    await page.getByTestId('send-msg-btn').click();
    await waitForText(page, 'messages', /hello from replay/);
    const seq1 = Number(await page.getByTestId('last-seq').textContent());

    await page.getByTestId('send-msg-btn').click();
    await page.waitForTimeout(200);
    await page.getByTestId('send-msg-btn').click();
    await page.waitForTimeout(200);
    const seqAfter = Number(await page.getByTestId('last-seq').textContent());
    expect(seqAfter).toBeGreaterThan(seq1);

    await page.getByTestId('since-input').fill(String(seq1));
    await page.getByTestId('replay-btn').click();
    await page.waitForTimeout(500);

    const replayCount = Number(await page.getByTestId('replay-count').textContent());
    expect(replayCount).toBeGreaterThan(0);
    expect(replayCount).toBeLessThanOrEqual(seqAfter - seq1);
  });
});
