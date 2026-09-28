import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

type ErrorFrame = {
  event: string;
  payload: {
    code?: string;
    detail?: { event?: string };
  };
};

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

  test('channel-scoped request returns the matched channel name', async ({ page }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('subscribe-room').click();
    await expect(page.getByTestId('subscribed')).toHaveText('yes');
    await page.getByTestId('get-ch-info').click();
    await expect(page.getByTestId('last-response')).toContainText('"channel":"room"');
  });

  test('void request reply uses a null payload slot on the wire', async ({ page }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);

    const frame = await page.evaluate(async () => {
      const ws = (window as unknown as { __ws?: WebSocket }).__ws;
      if (!ws) throw new Error('socket not exposed');

      const correlationId = 'wire-void-ack';
      return await new Promise<Record<string, unknown>>((resolve, reject) => {
        const previous = ws.onmessage;
        const timer = window.setTimeout(() => {
          ws.onmessage = previous;
          reject(new Error('timed out waiting for the void acknowledgement'));
        }, 2_000);

        ws.onmessage = (event) => {
          if (typeof event.data !== 'string') return;

          const candidate = window.__livethingDecode(event.data) as Record<string, unknown>;
          if (
            (candidate.metadata as { exchange?: { id?: unknown } } | undefined)?.exchange?.id !==
            correlationId
          ) {
            if (typeof previous === 'function') previous.call(ws, event);
            return;
          }

          window.clearTimeout(timer);
          ws.onmessage = previous;
          resolve(candidate);
        };

        ws.send(
          window.__livethingEncode({
            event: 'no-response',
            payload: {},
            metadata: { exchange: { id: correlationId } },
          }),
        );
      });
    });

    expect(frame.event).toBe('no-response');
    expect(frame.payload).toBe(null);
  });

  test('schema-failed request returns __error__ with its metadata.exchange.id', async ({
    page,
  }, testInfo) => {
    // A schema validation error keeps the request ID so the waiting request
    // rejects immediately instead of timing out.
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('malformed-strict-echo').click();
    await expect(page.getByTestId('last-response')).not.toHaveText('');
    const text = (await page.getByTestId('last-response').textContent()) ?? '';
    expect(text).toContain('"code"');
  });

  test('thrown request handler error returns __error__ with its metadata.exchange.id', async ({
    page,
  }, testInfo) => {
    // The error keeps the request ID so the request primitive can match it to
    // the pending call and reject that call immediately.
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('throwing-request').click();

    // The page records any frame whose metadata carries an exchange id
    // into responses[id] and exposes it as `last-response`.
    await expect(page.getByTestId('last-response')).not.toHaveText('');
    const text = (await page.getByTestId('last-response').textContent()) ?? '';
    // The error code is included in the payload; what matters most is
    // that the frame was correlated at all (otherwise the page would
    // show empty).
    expect(text).toContain('"code"');
  });

  test('non-string metadata.exchange.id returns validation-failed', async ({ page }, testInfo) => {
    // A buggy client wrapper might send the request ID as an object or a
    // number. The server rejects the frame with a typed validation error
    // so the wrapper learns immediately, instead of the response sitting
    // open until the wrapper's own timeout fires.
    await openPage(page, `test-${testInfo.testId}`);

    const err = await page.evaluate(async () => {
      const ws = (window as unknown as { __ws?: WebSocket }).__ws;
      if (!ws) throw new Error('socket not exposed');

      const original = ws.onmessage;

      return await new Promise<ErrorFrame>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          ws.onmessage = original;
          reject(new Error('timed out waiting for the malformed request ID error'));
        }, 5_000);

        ws.onmessage = (event) => {
          if (typeof event.data === 'string') {
            const frame = window.__livethingDecode(event.data) as ErrorFrame;
            const detail = frame.payload?.detail;
            if (
              frame.event === '__error__' &&
              frame.payload?.code === 'validation-failed' &&
              detail?.event === 'get-time'
            ) {
              window.clearTimeout(timer);
              ws.onmessage = original;
              resolve(frame);
              return;
            }
          }

          if (typeof original === 'function') original.call(ws, event);
        };

        ws.send(
          window.__livethingEncode({
            event: 'get-time',
            payload: {},
            metadata: { exchange: { id: { reqId: 1 } } },
          }),
        );
      });
    });

    // The non-string request ID fails the frame schema, so the server
    // cannot echo it back. The error detail carries the event name, which ties
    // this response to the get-time frame.
    expect(err.payload.code).toBe('validation-failed');
  });

  test('strict-object request schema accepts metadata.exchange.id outside the payload', async ({
    page,
  }, testInfo) => {
    // The frame carries the request ID in `metadata.exchange.id`, outside
    // `payload`. With a strict-object schema
    // (v.strictObject({ id: ... })), the user payload stays clean so
    // validation accepts it without seeing any transport markers.
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('strict-echo').click();
    await expect(page.getByTestId('last-response')).toContainText('"echoed":"value-42"');
  });

  test('calling ctx.respond twice delivers only the first reply and keeps the connection alive', async ({
    page,
  }, testInfo) => {
    // The handler calls ctx.respond twice ({ count: 1 } then { count: 2 }). The
    // second call is a server-side programming mistake, not a client concern —
    // the engine swallows it and logs server-side. The client receives only the
    // first reply, never a spurious internal-error.
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('double-response').click();
    await expect(page.getByTestId('last-response')).toContainText('"count":1');
    await expect(page.getByTestId('last-response')).not.toContainText('internal-error');

    // The connection is not torn down — a follow-up request still correlates.
    await page.getByTestId('get-time').click();
    await expect(page.getByTestId('last-response')).toContainText('fixed-now-string');
  });

  test('a request frame without metadata.exchange.id returns request-no-correlation', async ({
    page,
  }, testInfo) => {
    // A request handler needs `metadata.exchange.id` to route its response. A
    // frame that omits it cannot be answered, so the
    // server rejects it with a typed code instead of running the handler and
    // dropping the reply on the floor.
    await openPage(page, `test-${testInfo.testId}`);

    const err = await page.evaluate(async () => {
      const ws = (window as unknown as { __ws?: WebSocket }).__ws;
      if (!ws) throw new Error('socket not exposed');

      const original = ws.onmessage;

      return await new Promise<ErrorFrame>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          ws.onmessage = original;
          reject(new Error('timed out waiting for the missing request ID error'));
        }, 5_000);

        ws.onmessage = (event) => {
          if (typeof event.data === 'string') {
            const frame = window.__livethingDecode(event.data) as ErrorFrame;
            if (frame.event === '__error__' && frame.payload?.code === 'request-no-correlation') {
              window.clearTimeout(timer);
              ws.onmessage = original;
              resolve(frame);
              return;
            }
          }

          if (typeof original === 'function') original.call(ws, event);
        };

        ws.send(window.__livethingEncode({ event: 'get-time', payload: {} }));
      });
    });

    expect(err.payload.code).toBe('request-no-correlation');

    // Connection is alive — a properly correlated request still works.
    await page.getByTestId('get-time').click();
    await expect(page.getByTestId('last-response')).toContainText('fixed-now-string');
  });

  test('a schemaless request accepts any payload and echoes it back', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);

    const got = await page.evaluate(async () => {
      const ws = (window as unknown as { __ws?: WebSocket }).__ws;
      if (!ws) throw new Error('socket not exposed');

      const responses: Record<string, unknown>[] = [];
      const original = ws.onmessage;
      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') {
          const frame = window.__livethingDecode(ev.data);
          if (frame.metadata?.exchange?.id === 'anything-1') responses.push(frame);
        }

        if (typeof original === 'function') original.call(ws, ev);
      };

      ws.send(
        window.__livethingEncode({
          event: 'echo-anything-req',
          payload: { deep: { list: [1, 2, 3] }, flag: true },
          metadata: { exchange: { id: 'anything-1' } },
        }),
      );
      await new Promise((r) => setTimeout(r, 400));
      ws.onmessage = original;

      return responses;
    });

    expect(got.length).toBeGreaterThan(0);
    expect((got[0]!.payload as { got: unknown }).got).toEqual({
      deep: { list: [1, 2, 3] },
      flag: true,
    });
  });
});
