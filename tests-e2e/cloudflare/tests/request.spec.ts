import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

test.describe('request', () => {
  async function openPage(page: Page, room: string) {
    await page.goto(`/request?room=${room}`);
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');
  }

  test('top-level request: ctx.respond sends a reply tied to the request id', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('get-time').click();
    await expect(page.getByTestId('last-response')).toContainText('fixed-now-string');
  });

  test('namespace-scoped request returns a response inside the namespace', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('get-ns-info').click();
    await expect(page.getByTestId('last-response')).toContainText('"namespace":"ns"');
  });

  test('channel-scoped request returns the matched channel name', async ({ page }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('subscribe-room').click();
    await expect(page.getByTestId('subscribed')).toHaveText('yes');
    await page.getByTestId('get-ch-info').click();
    await expect(page.getByTestId('last-response')).toContainText('"channel":"room"');
  });

  test('handler that never calls ctx.respond settles via correlated __error__ with code "request-no-response"', async ({
    page,
  }, testInfo) => {
    // Pre-fix the runtime swallowed the missing-respond case silently: the
    // client's request promise hung until its own timeout, with no log and
    // no breadcrumb to find the forgotten ctx.respond(). Now the runtime
    // throws RequestNoResponse, the outer dispatcher routes it through
    // handleRuntimeError with the originating correlationId, and the
    // client's pending promise settles by rejecting with a typed code.
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('no-response').click();
    await expect(page.getByTestId('last-response')).not.toHaveText('');
    const text = (await page.getByTestId('last-response').textContent()) ?? '';
    expect(text).toContain('"code":"request-no-response"');
  });

  test('schema-failed request settles via __error__ frame with the original correlationId', async ({
    page,
  }, testInfo) => {
    // Pre-fix the inner schema-validation catch (separate code path from
    // a thrown handler) called handleRuntimeError without routing — the
    // `__error__` reached the client uncorrelated and the request hung
    // until timeout. The page only records frames whose __wskit carries
    // a correlationId, so the assertion `last-response not empty` is the
    // pin: a populated value means the error was correlated.
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('malformed-strict-echo').click();
    await expect(page.getByTestId('last-response')).not.toHaveText('');
    const text = (await page.getByTestId('last-response').textContent()) ?? '';
    expect(text).toContain('"code"');
  });

  test('thrown request handler error settles via __error__ frame with the original correlationId', async ({
    page,
  }, testInfo) => {
    // Pre-fix handleDispatchError called handleRuntimeError without
    // routing, so the `__error__` the client received carried no
    // correlationId. The request-response plugin only settles
    // pending requests when an inbound message has a matching id, so
    // the request hung until timeout instead of failing fast with the
    // server error.
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('throwing-request').click();

    // The page records any frame whose __wskit carries a correlationId
    // into responses[id] and exposes it as `last-response`.
    await expect(page.getByTestId('last-response')).not.toHaveText('');
    const text = (await page.getByTestId('last-response').textContent()) ?? '';
    // The error code is included in the payload; what matters most is
    // that the frame was correlated at all (otherwise the page would
    // show empty).
    expect(text).toContain('"code"');
  });

  test('non-string correlationId surfaces __error__ with code "validation-failed"', async ({
    page,
  }, testInfo) => {
    // A buggy client wrapper might send `correlationId` as an object or a
    // number. The server rejects the frame with a typed validation error
    // so the wrapper learns immediately, instead of the response sitting
    // open until the wrapper's own timeout fires.
    await openPage(page, `test-${testInfo.testId}`);

    const errors = await page.evaluate(async () => {
      const ws = (window as unknown as { __ws?: WebSocket }).__ws;
      if (!ws) throw new Error('socket not exposed');
      const got: { event: string; payload: Record<string, unknown> }[] = [];
      const original = ws.onmessage;
      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') got.push(JSON.parse(ev.data));
        if (typeof original === 'function') original.call(ws, ev);
      };
      ws.send(
        JSON.stringify({
          event: 'get-time',
          payload: {},
          __wskit: { correlationId: { reqId: 1 } },
        }),
      );
      await new Promise((r) => setTimeout(r, 300));
      ws.onmessage = original;
      return got.filter((m) => m.event === '__error__');
    });

    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.payload.code).toBe('validation-failed');
  });

  test('strict-object request schema accepts the payload with correlationId in __wskit', async ({
    page,
  }, testInfo) => {
    // The request-response wire envelope carries the correlationId in
    // `__wskit`, kept out of `payload`. With a strict-object schema
    // (v.strictObject({ id: ... })), the user payload stays clean so
    // validation accepts it without seeing any transport markers.
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('strict-echo').click();
    await expect(page.getByTestId('last-response')).toContainText('"echoed":"value-42"');
  });
});
