import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { connect, frames, installRig, send, waitForFrame } from './_ws-rig.ts';

const WS_PATH = '/ws/stream-durable-scoped';

async function openRig(page: Page) {
  await page.goto('/stream-durable-scoped');
  await installRig(page);
}

async function countChunks(page: Page, id: string, event: string): Promise<number> {
  return (await frames(page, id)).filter((f) => f.event === event).length;
}

test.describe('stream-nudges matrix', () => {
  test('plain stream() in a channel — nudge stops the generator mid-flight', async ({
    page,
  }, testInfo) => {
    const room = `snm-${testInfo.testId}`;
    await openRig(page);
    const a = await connect(page, WS_PATH, 'alice', room);
    await send(page, a, { event: '__subscribe__', payload: {}, __wskit: { channel: 'rooms' } });
    await waitForFrame(page, a, (f) => f.event === '__subscribeOk__');

    await send(page, a, { event: 'channel-tokens', payload: {}, __wskit: { channel: 'rooms' } });
    const ok = await waitForFrame(page, a, (f) => f.event === '__streamOk__');
    const streamId = ok.__wskit?.streamId as string;
    await page.waitForFunction(
      ([sid]) =>
        (window.__wskitFrames!(sid as string) ?? []).filter(
          (f) => f.event === 'channel-tokens' && typeof f.payload?.token === 'string',
        ).length >= 1,
      [a],
    );

    await send(page, a, {
      event: 'stop',
      payload: {},
      __wskit: { channel: 'rooms', streamId },
    });
    await waitForFrame(
      page,
      a,
      (f) => f.event === '__streamEnd__' && f.__wskit?.streamId === streamId,
    );

    const tokens = await countChunks(page, a, 'channel-tokens');
    expect(tokens).toBeLessThan(20);
    expect(tokens).toBeGreaterThanOrEqual(1);
  });

  test('plain stream() in a namespace — nudge stops the generator mid-flight', async ({
    page,
  }, testInfo) => {
    const room = `snm-${testInfo.testId}`;
    await openRig(page);
    const a = await connect(page, WS_PATH, 'alice', room);

    await send(page, a, { event: 'ns-tokens', payload: {}, __wskit: { namespace: 'v1' } });
    const ok = await waitForFrame(page, a, (f) => f.event === '__streamOk__');
    const streamId = ok.__wskit?.streamId as string;
    await page.waitForFunction(
      ([sid]) =>
        (window.__wskitFrames!(sid as string) ?? []).filter(
          (f) => f.event === 'ns-tokens' && typeof f.payload?.token === 'string',
        ).length >= 1,
      [a],
    );

    await send(page, a, {
      event: 'stop',
      payload: {},
      __wskit: { namespace: 'v1', streamId },
    });
    await waitForFrame(
      page,
      a,
      (f) => f.event === '__streamEnd__' && f.__wskit?.streamId === streamId,
    );

    const tokens = await countChunks(page, a, 'ns-tokens');
    expect(tokens).toBeLessThan(20);
    expect(tokens).toBeGreaterThanOrEqual(1);
  });

  test('recordedStream in a channel — nudge stops the generator mid-flight', async ({
    page,
  }, testInfo) => {
    const room = `snm-${testInfo.testId}`;
    await openRig(page);
    const a = await connect(page, WS_PATH, 'alice', room);
    await send(page, a, { event: '__subscribe__', payload: {}, __wskit: { channel: 'rooms' } });
    await waitForFrame(page, a, (f) => f.event === '__subscribeOk__');

    const streamId = 'history-nudged-1';
    await send(page, a, {
      event: 'history-nudged',
      payload: {},
      __wskit: { channel: 'rooms', streamId },
    });
    await waitForFrame(page, a, (f) => f.event === '__streamOk__');
    await page.waitForFunction(
      ([sid]) =>
        (window.__wskitFrames!(sid as string) ?? []).filter(
          (f) => f.event === 'history-nudged' && typeof f.payload?.idx === 'number',
        ).length >= 1,
      [a],
    );

    await send(page, a, {
      event: 'stop',
      payload: {},
      __wskit: { channel: 'rooms', streamId },
    });
    await waitForFrame(
      page,
      a,
      (f) => f.event === '__streamEnd__' && f.__wskit?.streamId === streamId,
    );

    const chunks = await countChunks(page, a, 'history-nudged');
    expect(chunks).toBeLessThan(20);
    expect(chunks).toBeGreaterThanOrEqual(1);
  });

  test('resumableStream in a namespace — nudge stops the generator mid-flight', async ({
    page,
  }, testInfo) => {
    const room = `snm-${testInfo.testId}`;
    await openRig(page);
    const a = await connect(page, WS_PATH, 'alice', room);

    const streamId = 'audit-nudged-1';
    await send(page, a, {
      event: 'audit-nudged',
      payload: {},
      __wskit: { namespace: 'v1', streamId },
    });
    await waitForFrame(page, a, (f) => f.event === '__streamOk__');
    await page.waitForFunction(
      ([sid]) =>
        (window.__wskitFrames!(sid as string) ?? []).filter(
          (f) => f.event === 'audit-nudged' && typeof f.payload?.row === 'number',
        ).length >= 1,
      [a],
    );

    await send(page, a, {
      event: 'stop',
      payload: {},
      __wskit: { namespace: 'v1', streamId },
    });
    await waitForFrame(
      page,
      a,
      (f) => f.event === '__streamEnd__' && f.__wskit?.streamId === streamId,
    );

    const chunks = await countChunks(page, a, 'audit-nudged');
    expect(chunks).toBeLessThan(20);
    expect(chunks).toBeGreaterThanOrEqual(1);
  });
});
