import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { connect, installRig, send, waitForFrame } from './_ws-rig.ts';

test.describe('intercept', () => {
  async function openPage(page: Page, room: string) {
    await page.goto(`/intercept?room=${room}`);
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');
  }

  test('top-level intercept rewrites the payload via matches() narrowing', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('send-top-pre').click();
    await expect(page.getByTestId('echoed')).toContainText('top:top-pre-rewritten');
  });

  test('namespace intercept rewrites within the namespace scope via matches()', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('send-ns-pre').click();
    await expect(page.getByTestId('echoed')).toContainText('ns:ns-pre-rewritten');
  });

  test('channel intercept rewrites within the channel scope via matches()', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('subscribe-room').click();
    await expect(page.getByTestId('subscribed')).toHaveText('yes');
    await page.getByTestId('send-ch-pre').click();
    await expect(page.getByTestId('echoed')).toContainText('ch:ch-pre-rewritten');
  });

  test('dynamic channel-family intercept rewrites within the family scope via matches()', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('subscribe-dynamic-room').click();
    await expect(page.getByTestId('dynamic-subscribed')).toHaveText('yes');
    await page.getByTestId('send-dyn-pre').click();
    await expect(page.getByTestId('echoed')).toContainText('dyn:dyn-pre-rewritten');
  });

  test('intercept returning void passes message through unchanged', async ({ page }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('send-top-passthrough').click();
    await expect(page.getByTestId('echoed')).toContainText('top:top-passthrough');
  });

  test('namespace intercept Block prevents the handler from running', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('send-ns-pre-block').click();
    // Give the blocked frame time to not produce any reply.
    await page.waitForTimeout(200);
    await expect(page.getByTestId('echoed')).toHaveText('');
    // Positive signal: a normal ns rewrite still works after a block.
    await page.getByTestId('send-ns-pre').click();
    await expect(page.getByTestId('echoed')).toContainText('ns:ns-pre-rewritten');
  });

  test('channel intercept Block prevents the handler from running', async ({ page }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('subscribe-room').click();
    await expect(page.getByTestId('subscribed')).toHaveText('yes');
    await page.getByTestId('send-ch-pre-block').click();
    await page.waitForTimeout(200);
    await expect(page.getByTestId('echoed')).toHaveText('');
    // Positive signal: a normal ch rewrite still works after a block.
    await page.getByTestId('send-ch-pre').click();
    await expect(page.getByTestId('echoed')).toContainText('ch:ch-pre-rewritten');
  });

  test('dynamic channel-family intercept Block prevents the handler from running', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('subscribe-dynamic-room').click();
    await expect(page.getByTestId('dynamic-subscribed')).toHaveText('yes');
    await page.getByTestId('send-dyn-pre-block').click();
    await page.waitForTimeout(200);
    await expect(page.getByTestId('echoed')).toHaveText('');
    await page.getByTestId('send-dyn-pre').click();
    await expect(page.getByTestId('echoed')).toContainText('dyn:dyn-pre-rewritten');
  });

  test('a frame with both namespace and channel is rejected with invalid-scope-markers', async ({
    page,
  }, testInfo) => {
    // Pre-fix the engine returned the namespace branch as soon as
    // `namespace` was present, silently ignoring `channel`. A client could
    // bypass channel-membership rules by stamping both markers on the
    // same frame.
    await openPage(page, `test-${testInfo.testId}`);
    await page.evaluate(() => {
      const ws = (window as unknown as { __ws?: WebSocket }).__ws;
      ws?.send(
        JSON.stringify({
          event: 'echo',
          payload: { text: 'mixed' },
          __wskit: { namespace: 'ns', channel: 'room' },
        }),
      );
    });
    await expect(page.getByTestId('last-error-code')).toHaveText('invalid-scope-markers');
    // Connection still healthy: a normal ns frame still works after the rejection.
    await page.getByTestId('send-ns-pre').click();
    await expect(page.getByTestId('echoed')).toContainText('ns:ns-pre-rewritten');
  });

  // ── nudge intercepts ──────────────────────────────────────────────────────

  test('intercept transforms nudge payload before it reaches the stream generator', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    // The page sends the hint nudge automatically when __streamOk__ arrives,
    // so it lands in the buffer before the generator drains nudges the first
    // time. The top-level intercept rewrites 'hello' → 'hello-intercepted'.
    await page.getByTestId('start-nudge-stream').click();
    await expect(page.getByTestId('nudge-chunks')).toContainText('hello-intercepted');
    await expect(page.getByTestId('nudge-stream-end')).toHaveText('yes');
  });

  test('Block thrown in a nudge intercept drops the nudge: generator sees no-hint', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    // 'hint-block' triggers a Block in the intercept — nudge is dropped before
    // reaching the buffer. The generator resumes with an empty nudge list and
    // yields 'no-hint'.
    await page.getByTestId('start-nudge-stream-block').click();
    await expect(page.getByTestId('nudge-stream-end')).toHaveText('yes');
    await expect(page.getByTestId('nudge-chunks')).toContainText('no-hint');
    await expect(page.getByTestId('nudge-chunks')).not.toContainText('hint-block');
  });

  // ── namespace-scoped nudge intercepts ─────────────────────────────────────

  test('namespace intercept transforms nudge payload for a namespace-scoped stream', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('start-ns-nudge-stream').click();
    await expect(page.getByTestId('ns-nudge-chunks')).toContainText('hello-ns-intercepted');
    await expect(page.getByTestId('ns-nudge-stream-end')).toHaveText('yes');
  });

  test('namespace intercept Block drops a nudge for a namespace-scoped stream', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('start-ns-nudge-stream-block').click();
    await expect(page.getByTestId('ns-nudge-stream-end')).toHaveText('yes');
    await expect(page.getByTestId('ns-nudge-chunks')).toContainText('no-hint');
    await expect(page.getByTestId('ns-nudge-chunks')).not.toContainText('ns-hint-block');
  });

  // ── channel-scoped nudge intercepts ───────────────────────────────────────

  test('channel intercept transforms nudge payload for a channel-scoped stream', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('subscribe-room').click();
    await expect(page.getByTestId('subscribed')).toHaveText('yes');
    await page.getByTestId('start-ch-nudge-stream').click();
    await expect(page.getByTestId('ch-nudge-chunks')).toContainText('hello-ch-intercepted');
    await expect(page.getByTestId('ch-nudge-stream-end')).toHaveText('yes');
  });

  test('channel intercept Block drops a nudge for a channel-scoped stream', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('subscribe-room').click();
    await expect(page.getByTestId('subscribed')).toHaveText('yes');
    await page.getByTestId('start-ch-nudge-stream-block').click();
    await expect(page.getByTestId('ch-nudge-stream-end')).toHaveText('yes');
    await expect(page.getByTestId('ch-nudge-chunks')).toContainText('no-hint');
    await expect(page.getByTestId('ch-nudge-chunks')).not.toContainText('ch-hint-block');
  });

  // ── request intercepts ────────────────────────────────────────────────────

  test('top-level intercept rewrites a request payload before the request handler runs', async ({
    page,
  }, testInfo) => {
    // Drive the wire directly with the shared rig: send a request frame
    // (kind === 'request') carrying a correlationId. The top-level intercept
    // matches 'intercept-req' and rewrites 'req-pre' → 'req-pre-rewritten'. The
    // handler echoes whatever payload it received, and the response comes back
    // as the same event name with the same correlationId — so the rewritten
    // text in the reply proves the intercept ran on the request frame.
    const room = `intercept-req-${testInfo.testId}`;
    await page.goto('/intercept');
    await installRig(page);
    const sock = await connect(page, { path: '/ws/intercept', username: 'alice', room });
    await send(page, sock, {
      event: 'intercept-req',
      payload: { text: 'req-pre' },
      __wskit: { correlationId: 'req-1' },
    });
    const reply = await waitForFrame(page, sock, {
      match: (f) => f.event === 'intercept-req' && f.__wskit?.correlationId === 'req-1',
    });
    expect(reply.payload.text).toBe('req-pre-rewritten');
  });
});
