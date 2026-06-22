import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { connect, installRig, send, waitForFrame } from './_ws-rig.ts';

/**
 * An early channel-membership or scope-resolution failure must keep the
 * incoming routing ids on the `__error__` frame so the client can match the
 * failure to its pending operation. A rejected nudge stays non-terminal.
 */
test.describe('error routing preservation for non-members', () => {
  test('a non-member request error keeps the correlationId', async ({ page }, testInfo) => {
    await page.goto('/request');
    await installRig(page);

    const a = await connect(page, {
      path: '/ws/request',
      username: 'alice',
      room: `erp-req-${testInfo.testId}`,
    });

    await send(page, a, {
      event: 'get-channel-info',
      payload: {},
      __wskit: { channel: 'room', correlationId: 'corr-xyz' },
    });

    const err = await waitForFrame(page, a, {
      match: (f) => f.event === '__error__' && f.__wskit?.correlationId === 'corr-xyz',
    });
    expect(err.payload.code).toBe('channel-not-subscribed');
    expect(err.__wskit?.channel).toBe('room');
  });

  test('a non-member stream-trigger error keeps the streamId', async ({ page }, testInfo) => {
    await page.goto('/intercept');
    await installRig(page);

    const a = await connect(page, {
      path: '/ws/intercept',
      username: 'alice',
      room: `erp-stream-${testInfo.testId}`,
    });

    await send(page, a, {
      event: 'ch-nudge-stream',
      payload: {},
      __wskit: { channel: 'room', streamId: 'st-xyz' },
    });

    const err = await waitForFrame(page, a, {
      match: (f) => f.event === '__error__' && f.__wskit?.streamId === 'st-xyz',
    });
    expect(err.payload.code).toBe('channel-not-subscribed');
  });

  test('a non-member nudge error keeps streamId, streamNudgeId, and streamTerminated:false', async ({
    page,
  }, testInfo) => {
    await page.goto('/intercept');
    await installRig(page);

    const a = await connect(page, {
      path: '/ws/intercept',
      username: 'alice',
      room: `erp-nudge-${testInfo.testId}`,
    });

    await send(page, a, {
      event: 'ch-hint',
      payload: { hint: 'x' },
      __wskit: { channel: 'room', streamId: 'sn-xyz', streamNudgeId: 'nudge-xyz' },
    });

    const err = await waitForFrame(page, a, {
      match: (f) => f.event === '__error__' && f.__wskit?.streamNudgeId === 'nudge-xyz',
    });
    expect(err.__wskit?.streamId).toBe('sn-xyz');
    expect(err.__wskit?.streamTerminated).toBe(false);
  });
});

/**
 * A nudge whose scope cannot be resolved (bad channel, bad/missing family key,
 * wrong static-vs-dynamic marker) must keep its nudge routing so the client's
 * nudge Promise rejects without treating the failure as terminal.
 */
test.describe('bad-scope nudge keeps nudge routing', () => {
  async function open(page: Page) {
    await page.goto('/intercept');
    await installRig(page);
  }

  test('bad channel name (does not match the family pattern)', async ({ page }, testInfo) => {
    await open(page);
    const a = await connect(page, {
      path: '/ws/intercept',
      username: 'alice',
      room: `bsn-badname-${testInfo.testId}`,
    });

    await send(page, a, {
      event: 'ch-hint',
      payload: { hint: 'x' },
      __wskit: {
        channel: 'not-a-room',
        channelFamily: 'rooms',
        streamId: 'bn-1',
        streamNudgeId: 'bn-nudge-1',
      },
    });

    const err = await waitForFrame(page, a, {
      match: (f) => f.event === '__error__' && f.__wskit?.streamNudgeId === 'bn-nudge-1',
    });
    expect(err.__wskit?.streamId).toBe('bn-1');
    expect(err.__wskit?.streamTerminated).toBe(false);
  });

  test('bad family key (no such family)', async ({ page }, testInfo) => {
    await open(page);
    const a = await connect(page, {
      path: '/ws/intercept',
      username: 'alice',
      room: `bsn-badfam-${testInfo.testId}`,
    });

    await send(page, a, {
      event: 'ch-hint',
      payload: { hint: 'x' },
      __wskit: {
        channel: 'room:1',
        channelFamily: 'no-such-family',
        streamId: 'bf-1',
        streamNudgeId: 'bf-nudge-1',
      },
    });

    const err = await waitForFrame(page, a, {
      match: (f) => f.event === '__error__' && f.__wskit?.streamNudgeId === 'bf-nudge-1',
    });
    expect(err.__wskit?.streamId).toBe('bf-1');
    expect(err.__wskit?.streamTerminated).toBe(false);
  });

  test('missing family key for a dynamic channel name', async ({ page }, testInfo) => {
    await open(page);
    const a = await connect(page, {
      path: '/ws/intercept',
      username: 'alice',
      room: `bsn-missfam-${testInfo.testId}`,
    });

    // `room:1` is a dynamic-family name but carries no channelFamily, so it is
    // read as a static channel that does not exist.
    await send(page, a, {
      event: 'ch-hint',
      payload: { hint: 'x' },
      __wskit: { channel: 'room:1', streamId: 'mf-1', streamNudgeId: 'mf-nudge-1' },
    });

    const err = await waitForFrame(page, a, {
      match: (f) => f.event === '__error__' && f.__wskit?.streamNudgeId === 'mf-nudge-1',
    });
    expect(err.__wskit?.streamId).toBe('mf-1');
    expect(err.__wskit?.streamTerminated).toBe(false);
  });

  test('wrong static-vs-dynamic scope (family key on a static channel)', async ({
    page,
  }, testInfo) => {
    await open(page);
    const a = await connect(page, {
      path: '/ws/intercept',
      username: 'alice',
      room: `bsn-wrongkind-${testInfo.testId}`,
    });

    // `room` is a static channel; supplying a family key routes it through the
    // family resolver, where the static name does not match the pattern.
    await send(page, a, {
      event: 'ch-hint',
      payload: { hint: 'x' },
      __wskit: {
        channel: 'room',
        channelFamily: 'rooms',
        streamId: 'wk-1',
        streamNudgeId: 'wk-nudge-1',
      },
    });

    const err = await waitForFrame(page, a, {
      match: (f) => f.event === '__error__' && f.__wskit?.streamNudgeId === 'wk-nudge-1',
    });
    expect(err.__wskit?.streamId).toBe('wk-1');
    expect(err.__wskit?.streamTerminated).toBe(false);
  });
});
