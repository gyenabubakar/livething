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
    const a = await connect(page, '/ws/stream-broadcast', 'alice', room);

    await send(page, a, {
      event: '_subscribe',
      payload: { _channel: channelKey, _channelScope: 'rooms' },
    });
    await waitForFrame(page, a, (f) => f.event === '_subscribeOk');

    await send(page, a, {
      event: 'start-room-stream',
      payload: { _channel: channelKey, _channelScope: 'rooms', count: 20 },
    });
    const ok = await waitForFrame(page, a, (f) => f.event === '_streamOk');
    const streamId = ok.payload._streamId as string;
    await page.waitForFunction(
      ([sid]) =>
        (window.__wskitFrames!(sid as string) ?? []).filter((f) => f.event === 'start-room-stream')
          .length >= 1,
      [a],
    );

    await send(page, a, {
      event: '_streamCancel',
      payload: { _channel: channelKey, _channelScope: 'rooms', _streamId: streamId },
    });
    await page.waitForTimeout(400);
    const snapshot = await chunkCount(page, a, 'start-room-stream');
    await page.waitForTimeout(500);
    const after = await chunkCount(page, a, 'start-room-stream');
    expect(after - snapshot).toBe(0);
    expect(after).toBeLessThan(20);
    // Plain stream cancel does not send _streamEnd.
    const ended = (await frames(page, a)).some(
      (f) => f.event === '_streamEnd' && f.payload._streamId === streamId,
    );
    expect(ended).toBe(false);
  });

  test('plain stream() in a namespace — _streamCancel stops chunks, no _streamEnd follows', async ({
    page,
  }, testInfo) => {
    const room = `scm-${testInfo.testId}`;
    await pageWithRig(page, '/namespace');
    const a = await connect(page, '/ws/namespace', 'alice', room);

    await send(page, a, {
      event: 'start-ns-stream',
      payload: { _namespace: 'ns', count: 20 },
    });
    const ok = await waitForFrame(page, a, (f) => f.event === '_streamOk');
    const streamId = ok.payload._streamId as string;
    await page.waitForFunction(
      ([sid]) =>
        (window.__wskitFrames!(sid as string) ?? []).filter((f) => f.event === 'start-ns-stream')
          .length >= 1,
      [a],
    );

    await send(page, a, {
      event: '_streamCancel',
      payload: { _namespace: 'ns', _streamId: streamId },
    });
    await page.waitForTimeout(400);
    const snapshot = await chunkCount(page, a, 'start-ns-stream');
    await page.waitForTimeout(500);
    const after = await chunkCount(page, a, 'start-ns-stream');
    expect(after - snapshot).toBe(0);
    expect(after).toBeLessThan(20);
    const ended = (await frames(page, a)).some(
      (f) => f.event === '_streamEnd' && f.payload._streamId === streamId,
    );
    expect(ended).toBe(false);
  });

  test('recordedStream in a channel — _streamCancel deletes the row, resume returns not-found', async ({
    page,
  }, testInfo) => {
    const room = `scm-${testInfo.testId}`;
    await pageWithRig(page, '/stream-durable-scoped');
    const a = await connect(page, '/ws/stream-durable-scoped', 'alice', room);
    await send(page, a, { event: '_subscribe', payload: { _channel: 'rooms' } });
    await waitForFrame(page, a, (f) => f.event === '_subscribeOk');

    const streamId = 'history-cancel-1';
    await send(page, a, {
      event: 'history',
      payload: { _channel: 'rooms', _streamId: streamId },
    });
    await waitForFrame(page, a, (f) => f.event === '_streamOk');
    await page.waitForFunction(
      ([sid]) =>
        (window.__wskitFrames!(sid as string) ?? []).filter(
          (f) => f.event === 'history' && typeof f.payload?.idx === 'number',
        ).length >= 1,
      [a],
    );

    await send(page, a, {
      event: '_streamCancel',
      payload: { _channel: 'rooms', _streamId: streamId },
    });
    await page.waitForTimeout(500);

    await send(page, a, {
      event: '_resumeStream',
      payload: { _channel: 'rooms', _streamId: streamId, since: 0 },
    });
    const err = await waitForFrame(page, a, (f) => f.event === '_error');
    expect(err.payload.code).toBe('stream-aborted');
    expect((err.payload.detail as { reason: string }).reason).toBe('not-found');
  });

  test('recordedStream in a namespace — _streamCancel deletes the row, resume returns not-found', async ({
    page,
  }, testInfo) => {
    const room = `scm-${testInfo.testId}`;
    await pageWithRig(page, '/stream-durable-scoped');
    const a = await connect(page, '/ws/stream-durable-scoped', 'alice', room);

    const streamId = 'logs-cancel-1';
    await send(page, a, {
      event: 'logs',
      payload: { _namespace: 'v1', _streamId: streamId },
    });
    await waitForFrame(page, a, (f) => f.event === '_streamOk');
    await page.waitForFunction(
      ([sid]) =>
        (window.__wskitFrames!(sid as string) ?? []).filter(
          (f) => f.event === 'logs' && typeof f.payload?.line === 'string',
        ).length >= 1,
      [a],
    );

    await send(page, a, {
      event: '_streamCancel',
      payload: { _namespace: 'v1', _streamId: streamId },
    });
    await page.waitForTimeout(500);

    await send(page, a, {
      event: '_resumeStream',
      payload: { _namespace: 'v1', _streamId: streamId, since: 0 },
    });
    const err = await waitForFrame(page, a, (f) => f.event === '_error');
    expect(err.payload.code).toBe('stream-aborted');
    expect((err.payload.detail as { reason: string }).reason).toBe('not-found');
  });

  test('resumableStream in a channel — _streamCancel deletes the row, resume returns not-found', async ({
    page,
  }, testInfo) => {
    const room = `scm-${testInfo.testId}`;
    await pageWithRig(page, '/stream-durable-scoped');
    const a = await connect(page, '/ws/stream-durable-scoped', 'alice', room);
    await send(page, a, { event: '_subscribe', payload: { _channel: 'rooms' } });
    await waitForFrame(page, a, (f) => f.event === '_subscribeOk');

    const streamId = 'paginate-cancel-1';
    await send(page, a, {
      event: 'paginate',
      payload: { _channel: 'rooms', _streamId: streamId },
    });
    await waitForFrame(page, a, (f) => f.event === '_streamOk');
    await page.waitForFunction(
      ([sid]) =>
        (window.__wskitFrames!(sid as string) ?? []).filter(
          (f) => f.event === 'paginate' && typeof f.payload?.row === 'number',
        ).length >= 1,
      [a],
    );

    await send(page, a, {
      event: '_streamCancel',
      payload: { _channel: 'rooms', _streamId: streamId },
    });
    await page.waitForTimeout(500);

    await send(page, a, {
      event: '_resumeStream',
      payload: { _channel: 'rooms', _streamId: streamId, since: 0 },
    });
    const err = await waitForFrame(page, a, (f) => f.event === '_error');
    expect(err.payload.code).toBe('stream-aborted');
    expect((err.payload.detail as { reason: string }).reason).toBe('not-found');
  });

  test('resumableStream in a namespace — _streamCancel deletes the row, resume returns not-found', async ({
    page,
  }, testInfo) => {
    const room = `scm-${testInfo.testId}`;
    await pageWithRig(page, '/stream-durable-scoped');
    const a = await connect(page, '/ws/stream-durable-scoped', 'alice', room);

    const streamId = 'audit-cancel-1';
    await send(page, a, {
      event: 'audit-export',
      payload: { _namespace: 'v1', _streamId: streamId },
    });
    await waitForFrame(page, a, (f) => f.event === '_streamOk');
    await page.waitForFunction(
      ([sid]) =>
        (window.__wskitFrames!(sid as string) ?? []).filter(
          (f) => f.event === 'audit-export' && typeof f.payload?.row === 'number',
        ).length >= 1,
      [a],
    );

    await send(page, a, {
      event: '_streamCancel',
      payload: { _namespace: 'v1', _streamId: streamId },
    });
    await page.waitForTimeout(500);

    await send(page, a, {
      event: '_resumeStream',
      payload: { _namespace: 'v1', _streamId: streamId, since: 0 },
    });
    const err = await waitForFrame(page, a, (f) => f.event === '_error');
    expect(err.payload.code).toBe('stream-aborted');
    expect((err.payload.detail as { reason: string }).reason).toBe('not-found');
  });
});
