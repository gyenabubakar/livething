import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { connect, frames, installRig, send, waitForFrame } from './_ws-rig.ts';

async function pageWithRig(page: Page, route: string) {
  await page.goto(route);
  await installRig(page);
}

async function chunkCount(page: Page, id: string, event: string): Promise<number> {
  return (await frames(page, id)).filter((f) => f.event === event).length;
}

test.describe('stream-cancel matrix', () => {
  test('plain stream() in a channel — _streamCancel stops chunks, no _streamEnd follows', async ({
    page,
  }, testInfo) => {
    const room = `scm-${testInfo.testId}`;
    await pageWithRig(page, '/stream-broadcast');
    const channelKey = `room:${testInfo.testId}`;
    const a = await connect(page, { path: '/ws/stream-broadcast', username: 'alice', room: room });

    await send(page, a, {
      event: '__subscribe__',
      payload: {},
      __wskit: { channel: channelKey, channelScope: 'rooms' },
    });
    await waitForFrame(page, a, { match: (f) => f.event === '__subscribeOk__' });

    await send(page, a, {
      event: 'start-room-stream',
      payload: { count: 20 },
      __wskit: { channel: channelKey, channelScope: 'rooms' },
    });
    const ok = await waitForFrame(page, a, { match: (f) => f.event === '__streamOk__' });
    const streamId = ok.__wskit?.streamId as string;
    await page.waitForFunction(
      ([sid]) =>
        (window.__wskitFrames!(sid as string) ?? []).filter((f) => f.event === 'start-room-stream')
          .length >= 1,
      [a],
    );

    await send(page, a, {
      event: '__streamCancel__',
      payload: {},
      __wskit: { streamId },
    });
    await page.waitForTimeout(400);
    const snapshot = await chunkCount(page, a, 'start-room-stream');
    await page.waitForTimeout(500);
    const after = await chunkCount(page, a, 'start-room-stream');
    expect(after - snapshot).toBe(0);
    expect(after).toBeLessThan(20);
    // Plain stream cancel does not send __streamEnd__.
    const ended = (await frames(page, a)).some(
      (f) => f.event === '__streamEnd__' && f.__wskit?.streamId === streamId,
    );
    expect(ended).toBe(false);
  });

  test('plain stream() in a namespace — _streamCancel stops chunks, no _streamEnd follows', async ({
    page,
  }, testInfo) => {
    const room = `scm-${testInfo.testId}`;
    await pageWithRig(page, '/namespace');
    const a = await connect(page, { path: '/ws/namespace', username: 'alice', room: room });

    await send(page, a, {
      event: 'start-ns-stream',
      payload: { count: 20 },
      __wskit: { namespace: 'ns' },
    });
    const ok = await waitForFrame(page, a, { match: (f) => f.event === '__streamOk__' });
    const streamId = ok.__wskit?.streamId as string;
    await page.waitForFunction(
      ([sid]) =>
        (window.__wskitFrames!(sid as string) ?? []).filter((f) => f.event === 'start-ns-stream')
          .length >= 1,
      [a],
    );

    await send(page, a, {
      event: '__streamCancel__',
      payload: {},
      __wskit: { streamId },
    });
    await page.waitForTimeout(400);
    const snapshot = await chunkCount(page, a, 'start-ns-stream');
    await page.waitForTimeout(500);
    const after = await chunkCount(page, a, 'start-ns-stream');
    expect(after - snapshot).toBe(0);
    expect(after).toBeLessThan(20);
    const ended = (await frames(page, a)).some(
      (f) => f.event === '__streamEnd__' && f.__wskit?.streamId === streamId,
    );
    expect(ended).toBe(false);
  });

  test('recordedStream in a channel — _streamCancel deletes the row, resume returns not-found', async ({
    page,
  }, testInfo) => {
    const room = `scm-${testInfo.testId}`;
    await pageWithRig(page, '/stream-durable-scoped');
    const a = await connect(page, {
      path: '/ws/stream-durable-scoped',
      username: 'alice',
      room: room,
    });
    await send(page, a, { event: '__subscribe__', payload: {}, __wskit: { channel: 'rooms' } });
    await waitForFrame(page, a, { match: (f) => f.event === '__subscribeOk__' });

    const streamId = 'history-cancel-1';
    await send(page, a, {
      event: 'history',
      payload: {},
      __wskit: { channel: 'rooms', streamId },
    });
    await waitForFrame(page, a, { match: (f) => f.event === '__streamOk__' });
    await page.waitForFunction(
      ([sid]) =>
        (window.__wskitFrames!(sid as string) ?? []).filter(
          (f) => f.event === 'history' && typeof f.payload?.idx === 'number',
        ).length >= 1,
      [a],
    );

    await send(page, a, {
      event: '__streamCancel__',
      payload: {},
      __wskit: { streamId },
    });
    await page.waitForTimeout(500);

    await send(page, a, {
      event: '__resumeStream__',
      payload: { lastKnownSeq: 0 },
      __wskit: { channel: 'rooms', streamId },
    });
    const err = await waitForFrame(page, a, { match: (f) => f.event === '__error__' });
    expect(err.payload.code).toBe('stream-aborted');
    expect((err.payload.detail as { reason: string }).reason).toBe('not-found');
  });

  test('recordedStream in a namespace — _streamCancel deletes the row, resume returns not-found', async ({
    page,
  }, testInfo) => {
    const room = `scm-${testInfo.testId}`;
    await pageWithRig(page, '/stream-durable-scoped');
    const a = await connect(page, {
      path: '/ws/stream-durable-scoped',
      username: 'alice',
      room: room,
    });

    const streamId = 'logs-cancel-1';
    await send(page, a, {
      event: 'logs',
      payload: {},
      __wskit: { namespace: 'v1', streamId },
    });
    await waitForFrame(page, a, { match: (f) => f.event === '__streamOk__' });
    await page.waitForFunction(
      ([sid]) =>
        (window.__wskitFrames!(sid as string) ?? []).filter(
          (f) => f.event === 'logs' && typeof f.payload?.line === 'string',
        ).length >= 1,
      [a],
    );

    await send(page, a, {
      event: '__streamCancel__',
      payload: {},
      __wskit: { streamId },
    });
    await page.waitForTimeout(500);

    await send(page, a, {
      event: '__resumeStream__',
      payload: { lastKnownSeq: 0 },
      __wskit: { namespace: 'v1', streamId },
    });
    const err = await waitForFrame(page, a, { match: (f) => f.event === '__error__' });
    expect(err.payload.code).toBe('stream-aborted');
    expect((err.payload.detail as { reason: string }).reason).toBe('not-found');
  });

  test('resumableStream in a channel — _streamCancel deletes the row, resume returns not-found', async ({
    page,
  }, testInfo) => {
    const room = `scm-${testInfo.testId}`;
    await pageWithRig(page, '/stream-durable-scoped');
    const a = await connect(page, {
      path: '/ws/stream-durable-scoped',
      username: 'alice',
      room: room,
    });
    await send(page, a, { event: '__subscribe__', payload: {}, __wskit: { channel: 'rooms' } });
    await waitForFrame(page, a, { match: (f) => f.event === '__subscribeOk__' });

    const streamId = 'paginate-cancel-1';
    await send(page, a, {
      event: 'paginate',
      payload: {},
      __wskit: { channel: 'rooms', streamId },
    });
    await waitForFrame(page, a, { match: (f) => f.event === '__streamOk__' });
    await page.waitForFunction(
      ([sid]) =>
        (window.__wskitFrames!(sid as string) ?? []).filter(
          (f) => f.event === 'paginate' && typeof f.payload?.row === 'number',
        ).length >= 1,
      [a],
    );

    await send(page, a, {
      event: '__streamCancel__',
      payload: {},
      __wskit: { streamId },
    });
    await page.waitForTimeout(500);

    await send(page, a, {
      event: '__resumeStream__',
      payload: { lastKnownSeq: 0 },
      __wskit: { channel: 'rooms', streamId },
    });
    const err = await waitForFrame(page, a, { match: (f) => f.event === '__error__' });
    expect(err.payload.code).toBe('stream-aborted');
    expect((err.payload.detail as { reason: string }).reason).toBe('not-found');
  });

  test('resumableStream in a namespace — _streamCancel deletes the row, resume returns not-found', async ({
    page,
  }, testInfo) => {
    const room = `scm-${testInfo.testId}`;
    await pageWithRig(page, '/stream-durable-scoped');
    const a = await connect(page, {
      path: '/ws/stream-durable-scoped',
      username: 'alice',
      room: room,
    });

    const streamId = 'audit-cancel-1';
    await send(page, a, {
      event: 'audit-export',
      payload: {},
      __wskit: { namespace: 'v1', streamId },
    });
    await waitForFrame(page, a, { match: (f) => f.event === '__streamOk__' });
    await page.waitForFunction(
      ([sid]) =>
        (window.__wskitFrames!(sid as string) ?? []).filter(
          (f) => f.event === 'audit-export' && typeof f.payload?.row === 'number',
        ).length >= 1,
      [a],
    );

    await send(page, a, {
      event: '__streamCancel__',
      payload: {},
      __wskit: { streamId },
    });
    await page.waitForTimeout(500);

    await send(page, a, {
      event: '__resumeStream__',
      payload: { lastKnownSeq: 0 },
      __wskit: { namespace: 'v1', streamId },
    });
    const err = await waitForFrame(page, a, { match: (f) => f.event === '__error__' });
    expect(err.payload.code).toBe('stream-aborted');
    expect((err.payload.detail as { reason: string }).reason).toBe('not-found');
  });

  test('cancel is idempotent — a second _streamCancel for the same id does not crash the connection', async ({
    page,
  }, testInfo) => {
    const room = `scm-idem-${testInfo.testId}`;
    await pageWithRig(page, '/stream-basic');
    const a = await connect(page, { path: '/ws/stream-basic', username: 'alice', room: room });

    await send(page, a, {
      event: 'start-tokens',
      payload: { count: 10 },
      __wskit: { streamId: 'tok-1' },
    });
    await waitForFrame(page, a, { match: (f) => f.event === '__streamOk__' });
    await page.waitForFunction(
      ([sid]) =>
        (window.__wskitFrames!(sid as string) ?? []).some((f) => f.event === 'start-tokens'),
      [a],
    );

    await send(page, a, { event: '__streamCancel__', payload: {}, __wskit: { streamId: 'tok-1' } });
    await page.waitForTimeout(150);
    // Second cancel of the now-dead id is a no-op, not a crash.
    await send(page, a, { event: '__streamCancel__', payload: {}, __wskit: { streamId: 'tok-1' } });
    await page.waitForTimeout(150);

    // Connection still alive — a fresh stream starts normally.
    await send(page, a, {
      event: 'start-empty',
      payload: {},
      __wskit: { streamId: 'alive-check' },
    });
    await waitForFrame(page, a, {
      match: (f) => f.event === '__streamOk__' && f.__wskit?.streamId === 'alive-check',
    });
  });

  test('cancel for a never-started id does not crash the connection', async ({
    page,
  }, testInfo) => {
    const room = `scm-never-${testInfo.testId}`;
    await pageWithRig(page, '/stream-basic');
    const a = await connect(page, { path: '/ws/stream-basic', username: 'alice', room: room });

    await send(page, a, {
      event: '__streamCancel__',
      payload: {},
      __wskit: { streamId: 'no-such-stream' },
    });
    await page.waitForTimeout(150);

    // Connection still alive — a fresh stream starts normally.
    await send(page, a, { event: 'start-empty', payload: {}, __wskit: { streamId: 'ck' } });
    await waitForFrame(page, a, {
      match: (f) => f.event === '__streamOk__' && f.__wskit?.streamId === 'ck',
    });
  });
});
