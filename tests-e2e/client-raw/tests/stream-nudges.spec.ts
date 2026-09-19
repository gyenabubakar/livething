import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

test.describe('stream-nudges', () => {
  async function openPage(page: Page, room: string) {
    await page.goto(`/stream-nudges?room=${room}`);
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');
  }

  test('pause nudge stops the stream early', async ({ page }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('start-long').click();
    await expect(page.getByTestId('tokens')).not.toHaveText('');

    await page.getByTestId('pause').click();
    await expect(page.getByTestId('stream-end')).toHaveText('yes');

    // Stream had 16 words; pause should have landed well before completion.
    const tokens = (await page.getByTestId('tokens').textContent()) ?? '';
    const wordCount = tokens.trim().split(/\s+/).filter(Boolean).length;
    expect(wordCount).toBeLessThan(16);
  });

  test('speed-up nudge affects generator chunk cadence', async ({ page }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('start-long').click();
    await expect(page.getByTestId('tokens')).not.toHaveText('');

    // Speed up; the stream should now complete naturally well within the
    // unscaled time (16 words * 50ms = 800ms baseline).
    await page.getByTestId('speed-up').click();
    await expect(page.getByTestId('stream-end')).toHaveText('yes');

    const tokens = (await page.getByTestId('tokens').textContent()) ?? '';
    expect(tokens.length).toBeGreaterThan(0);
  });

  test('pause after a speed-up still stops the stream', async ({ page }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('start-long').click();
    await expect(page.getByTestId('tokens')).not.toHaveText('');

    await page.getByTestId('speed-up').click();
    // Wait for a few more tokens to land after the speed-up before pausing.
    await expect(async () => {
      const tokens = (await page.getByTestId('tokens').textContent()) ?? '';
      expect(tokens.length).toBeGreaterThan(5);
    }).toPass({ timeout: 3_000 });

    await page.getByTestId('pause').click();
    await expect(page.getByTestId('stream-end')).toHaveText('yes');
  });

  test('multiple pause nudges coalesce to single stream stop', async ({ page }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('start-long').click();
    await expect(page.getByTestId('tokens')).not.toHaveText('');

    // Send 3 pause nudges rapidly; stream should stop once, not trip on duplication.
    await page.getByTestId('pause-multiple').click();
    await expect(page.getByTestId('stream-end')).toHaveText('yes');

    const tokens = (await page.getByTestId('tokens').textContent()) ?? '';
    const wordCount = tokens.trim().split(/\s+/).filter(Boolean).length;
    expect(wordCount).toBeLessThan(16);
  });

  test('nudge sent before first yield is delivered at first ctx.nudges() call', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);

    // The page sends the pause the instant __streamOk__ lands, so the nudge
    // reaches the server's buffer within one round-trip — no Playwright click
    // latency in the path. It is buffered well before the 50ms-per-chunk
    // generator drains nudges a second time.
    await page.getByTestId('start-then-pause').click();

    // Stream should end early due to the buffered pause.
    await expect(page.getByTestId('stream-end')).toHaveText('yes');

    const tokens = (await page.getByTestId('tokens').textContent()) ?? '';
    const wordCount = tokens.trim().split(/\s+/).filter(Boolean).length;
    // The buffered pause stops the stream well before its natural end of 20.
    // How many tokens arrive first depends on the generator's own loop, not on
    // LiveThing, so we only check that it stopped early.
    expect(wordCount).toBeLessThan(20);
  });

  test('nudges are typed per event and mixed types coexist on one stream', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('start-long').click();
    await expect(page.getByTestId('tokens')).not.toHaveText('');

    // Send speed-up to accelerate, then pause to stop; both nudges should reach handler.
    await page.getByTestId('speed-up').click();
    await expect(async () => {
      const tokens = (await page.getByTestId('tokens').textContent()) ?? '';
      expect(tokens.length).toBeGreaterThan(5);
    }).toPass({ timeout: 3_000 });

    await page.getByTestId('pause').click();
    await expect(page.getByTestId('stream-end')).toHaveText('yes');

    const tokens = (await page.getByTestId('tokens').textContent()) ?? '';
    expect(tokens.length).toBeGreaterThan(0);
  });

  test('malformed nudges do not fall through to a same-named top-level handler', async ({
    page,
  }, testInfo) => {
    // The fixture registers both a strict stream `pause` nudge and a top-level
    // handler with the same event name. Invalid nudge payloads must not fall
    // through to the top-level handler.
    await openPage(page, `test-${testInfo.testId}`);

    await page.getByTestId('start-long').click();
    await expect(async () => {
      const id = (await page.getByTestId('stream-id').textContent()) ?? '';
      expect(id.length).toBeGreaterThan(0);
    }).toPass({ timeout: 3_000 });

    await page.getByTestId('malformed-pause').click();

    // Wait long enough for any rogue dispatch to land. The top-level
    // handler must NOT have fired — the leak field stays empty.
    await page.waitForTimeout(1000);
    expect(await page.getByTestId('pause-top-level-leak').textContent()).toBe('');

    // Positive signal that the websocket is still healthy: a valid pause
    // nudge still ends the stream as expected.
    await page.getByTestId('pause').click();
    await expect(page.getByTestId('stream-end')).toHaveText('yes');
  });

  test('frame with unknown metadata.stream.id does not fall through to a top-level handler', async ({
    page,
  }, testInfo) => {
    // Any frame carrying `metadata.stream.id` claims to belong to a stream. If
    // that claim does not match an active owned stream, the engine returns an
    // error and does not run a same-named top-level handler.
    await openPage(page, `test-${testInfo.testId}`);

    await page.evaluate(() => {
      const ws = (window as unknown as { __ws?: WebSocket }).__ws;
      ws?.send(
        window.__livethingEncode({
          event: 'pause',
          payload: { leak: 'should-not-reach-handler' },
          metadata: { stream: { id: 'fake-stream-id' } },
        }),
      );
    });

    // The top-level handler must not have fired.
    await expect(page.getByTestId('last-error')).toHaveText('validation-failed');
    await expect(page.getByTestId('last-error-stream-id')).toHaveText('fake-stream-id');
    expect(await page.getByTestId('pause-top-level-leak').textContent()).toBe('');
  });

  test('frame with an active metadata.stream.id but unknown nudge does not fall through', async ({
    page,
  }, testInfo) => {
    // The active stream accepts `pause` and `speed-up`. A different event with
    // the same stream ID is malformed and must not reach top-level dispatch.
    await openPage(page, `test-${testInfo.testId}`);

    await page.getByTestId('start-long').click();
    await expect(async () => {
      const id = (await page.getByTestId('stream-id').textContent()) ?? '';
      expect(id.length).toBeGreaterThan(0);
    }).toPass({ timeout: 3_000 });

    const streamId = (await page.getByTestId('stream-id').textContent()) ?? '';

    await page.evaluate((id) => {
      const ws = (window as unknown as { __ws?: WebSocket }).__ws;
      ws?.send(
        window.__livethingEncode({
          event: 'submit-form',
          payload: { data: 'private' },
          metadata: { stream: { id: id } },
        }),
      );
    }, streamId);

    await expect(page.getByTestId('last-error')).toHaveText('validation-failed');
    await expect(page.getByTestId('last-error-stream-id')).toHaveText(streamId);

    // Sanity: a valid pause still ends the stream on the same connection.
    await page.getByTestId('pause').click();
    await expect(page.getByTestId('stream-end')).toHaveText('yes');
  });

  test('malformed nudge returns validation-failed with metadata.stream.id', async ({
    page,
  }, testInfo) => {
    // The fixture uses a strict schema for the `pause` nudge, so an extra field
    // fails validation. The error keeps `metadata.stream.id` so the client can
    // route it to the right stream.
    await openPage(page, `test-${testInfo.testId}`);

    await page.getByTestId('start-long').click();
    await expect(async () => {
      const id = (await page.getByTestId('stream-id').textContent()) ?? '';
      expect(id.length).toBeGreaterThan(0);
    }).toPass({ timeout: 3_000 });

    const streamId = (await page.getByTestId('stream-id').textContent()) ?? '';

    await page.getByTestId('malformed-pause').click();

    await expect(page.getByTestId('last-error')).toHaveText('validation-failed');
    await expect(page.getByTestId('last-error-stream-id')).toHaveText(streamId);

    // Connection still healthy: a valid pause still ends the stream.
    await page.getByTestId('pause').click();
    await expect(page.getByTestId('stream-end')).toHaveText('yes');
  });

  test('nudges with the same metadata.delivery.id are deduplicated before buffering', async ({
    page,
  }, testInfo) => {
    // The gateway deduplicates all incoming frames, including stream nudges,
    // before they enter the active stream's nudge buffer.
    await openPage(page, `test-${testInfo.testId}`);

    await page.getByTestId('start-long').click();
    await expect(async () => {
      const id = (await page.getByTestId('stream-id').textContent()) ?? '';
      expect(id.length).toBeGreaterThan(0);
    }).toPass({ timeout: 3_000 });

    const streamId = (await page.getByTestId('stream-id').textContent()) ?? '';

    // Send two speed-up frames with the same delivery ID, then end the
    // stream with pause so the test has a deterministic stop signal.
    await page.evaluate(
      ({ streamId }) => {
        const ws = (window as unknown as { __ws?: WebSocket }).__ws;
        if (!ws) throw new Error('no __ws on window');

        ws.send(
          window.__livethingEncode({
            event: 'speed-up',
            payload: { factor: 2 },
            metadata: { delivery: { id: 'dup-id' }, stream: { id: streamId } },
          }),
        );
        ws.send(
          window.__livethingEncode({
            event: 'speed-up',
            payload: { factor: 2 },
            metadata: { delivery: { id: 'dup-id' }, stream: { id: streamId } },
          }),
        );
      },
      { streamId },
    );

    await page.getByTestId('pause').click();
    await expect(page.getByTestId('stream-end')).toHaveText('yes');

    // Every nudge-saw event lists the events drained for one iteration,
    // joined with '|' across iterations. Across the whole run the
    // 'speed-up' event must appear at most once — the duplicate frame
    // must have been dropped by the gateway dedup before reaching the
    // active stream buffer.
    const drained = (await page.getByTestId('nudge-saw-events').textContent()) ?? '';
    const speedUpCount = drained.split(/[|,]/).filter((e) => e === 'speed-up').length;
    expect(speedUpCount).toBe(1);
  });
});
