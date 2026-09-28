import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { connect, installRig, send, waitForFrame } from './_ws-rig.ts';

/**
 * An early channel-membership or scope-resolution failure must keep the
 * incoming routing ids on the `__error__` frame so the client can match the
 * failure to its pending operation. A rejected nudge stays non-terminal.
 */
test.describe('error routing preservation for non-members', () => {
  test('a non-member request error preserves metadata.exchange.id', async ({ page }, testInfo) => {
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
      metadata: { exchange: { id: 'corr-xyz' }, channel: { name: 'room' } },
    });

    const err = await waitForFrame(page, a, {
      match: (f) => f.event === '__error__' && f.metadata?.exchange?.id === 'corr-xyz',
    });
    expect(err.payload.code).toBe('channel-not-subscribed');
    expect(err.metadata?.channel?.name).toBe('room');
  });

  test('a non-member stream-trigger error preserves metadata.stream.id', async ({
    page,
  }, testInfo) => {
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
      metadata: { channel: { name: 'room' }, stream: { id: 'st-xyz' } },
    });

    const err = await waitForFrame(page, a, {
      match: (f) => f.event === '__error__' && f.metadata?.stream?.id === 'st-xyz',
    });
    expect(err.payload.code).toBe('channel-not-subscribed');
  });

  test('a non-member nudge error preserves stream metadata and the non-terminal flag', async ({
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
      metadata: { channel: { name: 'room' }, stream: { id: 'sn-xyz', nudgeId: 'nudge-xyz' } },
    });

    const err = await waitForFrame(page, a, {
      match: (f) => f.event === '__error__' && f.metadata?.stream?.nudgeId === 'nudge-xyz',
    });
    expect(err.metadata?.stream?.id).toBe('sn-xyz');
    expect(err.metadata?.stream?.terminated).toBe(false);
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
      metadata: {
        channel: { name: 'not-a-room', family: 'rooms' },
        stream: { id: 'bn-1', nudgeId: 'bn-nudge-1' },
      },
    });

    const err = await waitForFrame(page, a, {
      match: (f) => f.event === '__error__' && f.metadata?.stream?.nudgeId === 'bn-nudge-1',
    });
    expect(err.metadata?.stream?.id).toBe('bn-1');
    expect(err.metadata?.stream?.terminated).toBe(false);
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
      metadata: {
        channel: { name: 'room:1', family: 'no-such-family' },
        stream: { id: 'bf-1', nudgeId: 'bf-nudge-1' },
      },
    });

    const err = await waitForFrame(page, a, {
      match: (f) => f.event === '__error__' && f.metadata?.stream?.nudgeId === 'bf-nudge-1',
    });
    expect(err.metadata?.stream?.id).toBe('bf-1');
    expect(err.metadata?.stream?.terminated).toBe(false);
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
      metadata: { channel: { name: 'room:1' }, stream: { id: 'mf-1', nudgeId: 'mf-nudge-1' } },
    });

    const err = await waitForFrame(page, a, {
      match: (f) => f.event === '__error__' && f.metadata?.stream?.nudgeId === 'mf-nudge-1',
    });
    expect(err.metadata?.stream?.id).toBe('mf-1');
    expect(err.metadata?.stream?.terminated).toBe(false);
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
      metadata: {
        channel: { name: 'room', family: 'rooms' },
        stream: { id: 'wk-1', nudgeId: 'wk-nudge-1' },
      },
    });

    const err = await waitForFrame(page, a, {
      match: (f) => f.event === '__error__' && f.metadata?.stream?.nudgeId === 'wk-nudge-1',
    });
    expect(err.metadata?.stream?.id).toBe('wk-1');
    expect(err.metadata?.stream?.terminated).toBe(false);
  });
});
