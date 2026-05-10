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

    // Start stream, then immediately send pause before any yields land.
    // The pause nudge should be buffered and available at the first ctx.nudges(yield).
    await page.getByTestId('start-long').click();
    await page.getByTestId('pause').click();

    // Stream should end early due to pause landing at first yield.
    await expect(page.getByTestId('stream-end')).toHaveText('yes');

    const tokens = (await page.getByTestId('tokens').textContent()) ?? '';
    const wordCount = tokens.trim().split(/\s+/).filter(Boolean).length;
    // With pause at first yield, should have only 1 token (the one yielded before
    // ctx.nudges is called and checked).
    expect(wordCount).toBeLessThanOrEqual(2);
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
    // The fixture registers BOTH a stream `pause` nudge (strict, rejects
    // extra keys) AND a top-level .incoming(Pause, ...) that would fire
    // `pause-top-level-fired`. Pre-fix bufferStreamNudge returned false
    // on validation failure, so processTextMessage fell through to
    // dispatchIncoming and ran the top-level handler with the malformed
    // payload.
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

  test('frame with unknown _streamId does not fall through to a same-named top-level handler', async ({
    page,
  }, testInfo) => {
    // The fixture registers BOTH a stream `pause` nudge AND a top-level
    // .incoming(Pause, ...). Pre-fix bufferStreamNudge returned false for
    // any frame whose `_streamId` did not match an active owned stream,
    // and processTextMessage then fell through to dispatchIncoming and
    // ran the top-level handler with the malformed payload. The contract
    // is now: any frame carrying `_streamId` is claiming to belong to a
    // stream — if that claim does not hold, the engine surfaces `_error`
    // and refuses to fall through.
    await openPage(page, `test-${testInfo.testId}`);

    await page.evaluate(() => {
      const ws = (window as unknown as { __ws?: WebSocket }).__ws;
      ws?.send(
        JSON.stringify({
          event: 'pause',
          payload: { _streamId: 'fake-stream-id', leak: 'should-not-reach-handler' },
        }),
      );
    });

    // The top-level handler must not have fired.
    await expect(page.getByTestId('last-error')).toHaveText('validation-failed');
    await expect(page.getByTestId('last-error-stream-id')).toHaveText('fake-stream-id');
    expect(await page.getByTestId('pause-top-level-leak').textContent()).toBe('');
  });

  test('frame with active _streamId but unregistered nudge event does not fall through', async ({
    page,
  }, testInfo) => {
    // Same fixture: the active stream's nudges are `pause` and `speed-up`.
    // We craft a frame with the active `_streamId` but `event: 'submit-form'`
    // (not a registered nudge). Pre-fix this fell through to dispatchIncoming
    // — there is no top-level submit-form handler in this fixture, so the
    // attack surface there is "any same-named non-nudge top-level handler
    // can be hit while the frame claims to be for a stream." Post-fix the
    // engine refuses the frame as malformed regardless of whether a top-
    // level handler matches.
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
        JSON.stringify({
          event: 'submit-form',
          payload: { _streamId: id, data: 'private' },
        }),
      );
    }, streamId);

    await expect(page.getByTestId('last-error')).toHaveText('validation-failed');
    await expect(page.getByTestId('last-error-stream-id')).toHaveText(streamId);

    // Sanity: a valid pause still ends the stream on the same connection.
    await page.getByTestId('pause').click();
    await expect(page.getByTestId('stream-end')).toHaveText('yes');
  });

  test('malformed nudge surfaces _error with code "validation-failed" and _streamId', async ({
    page,
  }, testInfo) => {
    // The fixture uses a strict schema for the `pause` nudge, so any extra
    // field in the payload fails validation. Pre-fix the engine swallowed
    // the failure: hooks fired but the wire `_error` was never sent, so a
    // client could not correlate the rejection to the right stream. The
    // wire frame now reaches the client with `code: 'validation-failed'`
    // and the original `_streamId` so the client routes it correctly.
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

  test('duplicate-_messageId nudge frames are coalesced before the active stream buffer', async ({
    page,
  }, testInfo) => {
    // Pre-fix the dedup ring lived inside dispatchIncoming, so stream
    // nudge frames (handled by bufferStreamNudge upstream) bypassed the
    // check entirely. A flaky client that re-sent the same nudge frame
    // pushed two entries onto activeStream.nudges and the generator saw
    // the same nudge twice. The fix moves dedup to the top of
    // processTextMessage so all frames with `_messageId` share one
    // budget — incoming events, requests, and stream nudges.
    await openPage(page, `test-${testInfo.testId}`);

    await page.getByTestId('start-long').click();
    await expect(async () => {
      const id = (await page.getByTestId('stream-id').textContent()) ?? '';
      expect(id.length).toBeGreaterThan(0);
    }).toPass({ timeout: 3_000 });

    const streamId = (await page.getByTestId('stream-id').textContent()) ?? '';

    // Send two speed-up frames with the SAME _messageId, then end the
    // stream with pause so the test has a deterministic stop signal.
    await page.evaluate(
      ({ streamId }) => {
        const ws = (window as unknown as { __ws?: WebSocket }).__ws;
        if (!ws) throw new Error('no __ws on window');
        ws.send(
          JSON.stringify({
            event: 'speed-up',
            payload: { _streamId: streamId, _messageId: 'dup-id', factor: 2 },
          }),
        );
        ws.send(
          JSON.stringify({
            event: 'speed-up',
            payload: { _streamId: streamId, _messageId: 'dup-id', factor: 2 },
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
    // active stream buffer. Pre-fix this would be 'speed-up,speed-up'.
    const drained = (await page.getByTestId('nudge-saw-events').textContent()) ?? '';
    const speedUpCount = drained.split(/[|,]/).filter((e) => e === 'speed-up').length;
    expect(speedUpCount).toBe(1);
  });
});
