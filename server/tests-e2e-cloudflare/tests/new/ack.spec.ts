import { expect, test } from '@playwright/test';

test.describe('ack', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    await page.goto(`/ack?room=${room}`);
    await expect(page.getByTestId('status')).toHaveText('disconnected');
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');
  });

  test('handler that completes successfully emits _ack with the caller-provided _ackId', async ({
    page,
  }) => {
    await page.getByTestId('send-ok').click();
    await expect(page.getByTestId('reply')).toHaveText('yes');
    await expect(page.getByTestId('ack-ids')).toContainText('ack-ok');
  });

  test('ack is not emitted when handler throws', async ({ page }) => {
    // Baseline ack proves the wire is healthy.
    await page.getByTestId('send-ok').click();
    await expect(page.getByTestId('ack-ids')).toContainText('ack-ok');

    // Throwing handler never calls ctx.ack(); no _ack frame should arrive.
    await page.getByTestId('send-throw').click();

    // Positive signal: follow the throw with a second successful send. Once
    // its ack arrives, the throw-me frame has fully been processed — if its
    // ack were going to come, it would be in the list by now.
    await page.getByTestId('send-ok-2').click();
    await expect(page.getByTestId('ack-ids')).toContainText('ack-ok-2');
    await expect(page.getByTestId('ack-ids')).not.toContainText('ack-throw');
  });
  test('multiple acks in sequence each carry their own _ackId', async ({ page }) => {
    await page.getByTestId('send-ok').click();
    await expect(page.getByTestId('ack-ids')).toContainText('ack-ok');

    await page.getByTestId('send-ok-2').click();
    await expect(page.getByTestId('ack-ids')).toContainText('ack-ok-2');

    // Both should be present in the comma-separated list.
    const ackIds = await page.getByTestId('ack-ids').textContent();
    expect(ackIds).toContain('ack-ok');
    expect(ackIds).toContain('ack-ok-2');
  });
  test('message without _ackId does not emit _ack', async ({ page }) => {
    // Send a message with no _ackId field at all. Add a driver button for this.
    await page.getByTestId('send-no-ack-id').click();

    // Follow with a known ack to prove the wire is still healthy and the
    // previous message was fully processed.
    await page.getByTestId('send-ok').click();
    await expect(page.getByTestId('ack-ids')).toContainText('ack-ok');

    // The list should only contain ack-ok, not any undefined/null ack.
    const ackIds = await page.getByTestId('ack-ids').textContent();
    expect(ackIds).toBe('ack-ok');
  });
});
