import { expect, test } from '@playwright/test';

// Phase 2: server→client targeted requests, exercised over the real wire. The
// page connects raw, the server asks `ask-permission`, and the page answers (or
// not) by hand — so a real round-trip, an invalid-response rejection, and a
// timeout are all observable end to end.
test.describe('server→client request', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    await page.goto(`/server-request?room=${room}`);
    await expect(page.getByTestId('status')).toHaveText('disconnected');
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');
  });

  test('round-trip: the client answers and the server resolves with it', async ({ page }) => {
    await page.getByTestId('answer-good').click();
    await page.getByTestId('trigger').click();

    // The server asked the client the declared request...
    await expect(page.getByTestId('ask-action')).toHaveText('delete');
    // ...and resolved its promise with the client's typed answer.
    await expect(page.getByTestId('outcome')).toHaveText('true');
  });

  test('an answer that fails the response schema rejects with request-invalid-response', async ({
    page,
  }) => {
    await page.getByTestId('answer-bad').click();
    await page.getByTestId('trigger').click();

    await expect(page.getByTestId('ask-action')).toHaveText('delete');
    await expect(page.getByTestId('error-outcome')).toHaveText('request-invalid-response');
  });

  test('no answer before the timeout rejects with timeout', async ({ page }) => {
    await page.getByTestId('answer-drop').click();
    await page.getByTestId('trigger-timeout').click();

    await expect(page.getByTestId('ask-action')).toHaveText('slow');
    await expect(page.getByTestId('error-outcome')).toHaveText('timeout');
  });

  test('a declined request fast-fails with request-no-response, not a timeout', async ({
    page,
  }) => {
    // The client replies with the `__error__` frame a typed client sends when
    // its handler throws / it has no handler. The server must route it to the
    // pending request and reject FAST — the default request timeout is 10s, so a
    // ~5s assertion would fail if the decline were misrouted (the original bug).
    await page.getByTestId('answer-decline').click();
    await page.getByTestId('trigger').click();

    await expect(page.getByTestId('ask-action')).toHaveText('delete');
    await expect(page.getByTestId('error-outcome')).toHaveText('request-no-response');
  });

  test('a bare-marker ack resolves the server promise with undefined, ignoring any payload the client returns', async ({
    page,
  }) => {
    await page.getByTestId('trigger-ack').click();
    await expect(page.getByTestId('ack-outcome')).toHaveText('undefined');
  });
});
