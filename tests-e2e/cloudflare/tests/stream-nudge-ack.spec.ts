import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { connect, frames, installRig, send, waitForFrame } from './_ws-rig.ts';

const WS_PATH = '/ws/stream-nudges';

/**
 * A nudge is now acknowledged: a valid one gets `__nudgeOk__` (so the client's
 * `nudge()` Promise resolves), and a malformed one gets a non-terminal `__error__`
 * (`streamTerminated: false`) that rejects only that nudge while the stream runs on.
 */
test.describe('stream-nudges — nudge acknowledgement', () => {
  test('valid nudge → __nudgeOk__; bad nudge → non-terminal __error__, stream continues', async ({
    page,
  }: {
    page: Page;
  }, testInfo) => {
    await page.goto('/stream-nudges');
    await installRig(page);

    const room = `nack-${testInfo.testId}-${Date.now()}`;
    const streamId = 'ns-ack-1';
    const a = await connect(page, { path: WS_PATH, username: 'alice', room });

    // A long prompt keeps the stream running while we nudge it.
    await send(page, a, {
      event: 'start-nudge-stream',
      payload: { prompt: 'one two three four five six seven eight nine ten eleven twelve' },
      __wskit: { streamId },
    });
    await waitForFrame(page, a, {
      match: (f) => f.event === '__streamOk__' && f.__wskit?.streamId === streamId,
    });

    // A valid nudge is confirmed with __nudgeOk__ echoing the streamNudgeId.
    await send(page, a, {
      event: 'speed-up',
      payload: { factor: 2 },
      __wskit: { streamId, streamNudgeId: 'good-1' },
    });
    const ok = await waitForFrame(page, a, {
      match: (f) => f.event === '__nudgeOk__' && f.__wskit?.streamNudgeId === 'good-1',
    });
    expect(ok.__wskit?.streamId).toBe(streamId);

    // A malformed nudge (`pause` is a strict empty object) is rejected — but
    // non-terminally: the error carries streamTerminated:false.
    await send(page, a, {
      event: 'pause',
      payload: { leak: 'x' },
      __wskit: { streamId, streamNudgeId: 'bad-1' },
    });
    const err = await waitForFrame(page, a, {
      match: (f) => f.event === '__error__' && f.__wskit?.streamNudgeId === 'bad-1',
    });
    expect(err.payload.code).toBe('validation-failed');
    expect(err.__wskit?.streamTerminated).toBe(false);

    // The stream survived the rejected nudge and still completes.
    await waitForFrame(page, a, {
      match: (f) => f.event === '__streamEnd__' && f.__wskit?.streamId === streamId,
    });
  });

  test('a nudge past the buffer cap is rejected non-terminally; the stream keeps running', async ({
    page,
  }: {
    page: Page;
  }, testInfo) => {
    await page.goto('/stream-nudges');
    await installRig(page);

    const room = `nof-${testInfo.testId}-${Date.now()}`;
    const streamId = 'ns-overflow-1';
    const a = await connect(page, { path: WS_PATH, username: 'alice', room });

    // A long prompt keeps the stream running while we flood it with nudges.
    await send(page, a, {
      event: 'start-nudge-stream',
      payload: { prompt: Array.from({ length: 40 }, (_, i) => `w${i}`).join(' ') },
      __wskit: { streamId },
    });
    await waitForFrame(page, a, {
      match: (f) => f.event === '__streamOk__' && f.__wskit?.streamId === streamId,
    });

    // Burst 300 valid nudges in a single tick — past the 256 cap, before the
    // generator can drain. `factor: 1` keeps the stream's pace unchanged.
    await page.evaluate(
      ([id, sid]) => {
        for (let i = 0; i < 300; i++) {
          window.__wskitSend!(id, {
            event: 'speed-up',
            payload: { factor: 1 },
            __wskit: { streamId: sid, streamNudgeId: `flood-${i}` },
          });
        }
      },
      [a, streamId] as const,
    );

    // At least one nudge overflowed: a non-terminal `nudge-overflow` error.
    const over = await waitForFrame(page, a, {
      match: (f) => f.event === '__error__' && f.payload.code === 'nudge-overflow',
    });
    expect(over.__wskit?.streamTerminated).toBe(false);
    expect((over.payload as { detail?: { cap?: number } }).detail?.cap).toBe(256);
    expect(typeof over.__wskit?.streamNudgeId).toBe('string');

    // The overflow did NOT terminate the stream — no terminal error frame...
    const all = await frames(page, a);
    expect(all.some((f) => f.event === '__error__' && f.__wskit?.streamTerminated === true)).toBe(
      false,
    );

    // ...and the stream still completes.
    await waitForFrame(page, a, {
      match: (f) => f.event === '__streamEnd__' && f.__wskit?.streamId === streamId,
    });
  });
});
