import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { connect, frames, installRig, send, waitForFrame } from './_ws-rig.ts';

const WS_PATH = '/ws/stream-nudges';

/**
 * A nudge is now acknowledged: a valid one gets `__nudgeOk__` (so the client's
 * `nudge()` Promise resolves), and a malformed one gets a non-terminal `__error__`
 * (`stream.terminated: false`) that rejects only that nudge while the stream runs on.
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
      metadata: { stream: { id: streamId } },
    });
    await waitForFrame(page, a, {
      match: (f) => f.event === '__streamOk__' && f.metadata?.stream?.id === streamId,
    });

    // A valid nudge is confirmed with __nudgeOk__ echoing the stream.nudgeId.
    await send(page, a, {
      event: 'speed-up',
      payload: { factor: 2 },
      metadata: { stream: { id: streamId, nudgeId: 'good-1' } },
    });
    const ok = await waitForFrame(page, a, {
      match: (f) => f.event === '__nudgeOk__' && f.metadata?.stream?.nudgeId === 'good-1',
    });
    expect(ok.metadata?.stream?.id).toBe(streamId);

    // A malformed nudge (`pause` is a strict empty object) is rejected — but
    // non-terminally: the error carries stream.terminated:false.
    await send(page, a, {
      event: 'pause',
      payload: { leak: 'x' },
      metadata: { stream: { id: streamId, nudgeId: 'bad-1' } },
    });
    const err = await waitForFrame(page, a, {
      match: (f) => f.event === '__error__' && f.metadata?.stream?.nudgeId === 'bad-1',
    });
    expect(err.payload.code).toBe('validation-failed');
    expect(err.metadata?.stream?.terminated).toBe(false);

    // The stream survived the rejected nudge and still completes.
    await waitForFrame(page, a, {
      match: (f) => f.event === '__streamEnd__' && f.metadata?.stream?.id === streamId,
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

    // Hold the generator before its first yield so every nudge is buffered.
    await send(page, a, {
      event: 'start-nudge-stream',
      payload: { prompt: '__hold-overflow__' },
      metadata: { stream: { id: streamId } },
    });
    await waitForFrame(page, a, {
      match: (f) => f.event === '__streamOk__' && f.metadata?.stream?.id === streamId,
    });

    // Burst 300 valid nudges while the generator is held. This is past the
    // 256-item cap and cannot depend on scheduling speed.
    await page.evaluate(
      ([id, sid]) => {
        for (let i = 0; i < 300; i++) {
          window.__livethingSend!(id, {
            event: 'speed-up',
            payload: { factor: 1 },
            metadata: { stream: { id: sid, nudgeId: `flood-${i}` } },
          });
        }
      },
      [a, streamId] as const,
    );

    // At least one nudge overflowed: a non-terminal `nudge-overflow` error.
    const over = await waitForFrame(page, a, {
      match: (f) => f.event === '__error__' && f.payload.code === 'nudge-overflow',
    });
    expect(over.metadata?.stream?.terminated).toBe(false);
    expect((over.payload as { detail?: { cap?: number } }).detail?.cap).toBe(256);
    expect(typeof over.metadata?.stream?.nudgeId).toBe('string');

    await send(page, a, {
      event: 'release-overflow',
      payload: {},
    });

    // The overflow did NOT terminate the stream — no terminal error frame...
    const all = await frames(page, a);
    expect(
      all.some((f) => f.event === '__error__' && f.metadata?.stream?.terminated === true),
    ).toBe(false);

    // ...and the stream still completes.
    await waitForFrame(page, a, {
      match: (f) => f.event === '__streamEnd__' && f.metadata?.stream?.id === streamId,
    });
  });

  test('a DURABLE stream rejects an overflowing nudge non-terminally too', async ({
    page,
  }: {
    page: Page;
  }, testInfo) => {
    await page.goto('/stream-durable');
    await installRig(page);

    const room = `dof-${testInfo.testId}-${Date.now()}`;
    const streamId = 'durable-overflow-1';
    const a = await connect(page, { path: '/ws/stream-durable', username: 'alice', room });

    // Hold the recorded stream before its first yield so every nudge is
    // buffered while the overflow is produced.
    await send(page, a, {
      event: 'count-tokens-nudged',
      payload: { hold: true },
      metadata: { stream: { id: streamId } },
    });
    const ok = await waitForFrame(page, a, {
      match: (f) => f.event === '__streamOk__' && f.metadata?.stream?.id === streamId,
    });
    expect(ok.metadata?.stream?.durability).toBe('persistent'); // confirm it is durable

    // Burst 300 'stop' nudges while the generator is held. This is past the
    // 256-item cap and cannot depend on scheduling speed.
    await page.evaluate(
      ([id, sid]) => {
        for (let i = 0; i < 300; i++) {
          window.__livethingSend!(id, {
            event: 'stop',
            payload: {},
            metadata: { stream: { id: sid, nudgeId: `flood-${i}` } },
          });
        }
      },
      [a, streamId] as const,
    );

    // The durable path rejects the overflow the same non-terminal way.
    const over = await waitForFrame(page, a, {
      match: (f) => f.event === '__error__' && f.payload.code === 'nudge-overflow',
    });
    expect(over.metadata?.stream?.terminated).toBe(false);
    expect((over.payload as { detail?: { cap?: number } }).detail?.cap).toBe(256);

    await send(page, a, {
      event: 'release-overflow',
      payload: {},
    });

    // The overflow did not terminate the stream — no terminal error frame...
    const all = await frames(page, a);
    expect(
      all.some((f) => f.event === '__error__' && f.metadata?.stream?.terminated === true),
    ).toBe(false);

    // ...and the buffered 'stop' nudges then end it cleanly.
    await waitForFrame(page, a, {
      match: (f) => f.event === '__streamEnd__' && f.metadata?.stream?.id === streamId,
    });
  });
});
