import { expect, test } from '@playwright/test';
import { closeSocket, connect, frames, installRig, send, waitForFrame } from './_ws-rig.ts';
import type { WireFrame } from './_ws-rig.ts';

const WS_PATH = '/ws/group-full-surface';

test.describe('group full surface', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/group-full-surface');
    await installRig(page);
  });

  test('group.on routes incoming and onConnect sent welcome', async ({ page }, testInfo) => {
    const room = `gfs-on-${testInfo.testId}-${Date.now()}`;
    const a = await connect(page, { path: WS_PATH, username: 'alice', room: room });
    await waitForFrame(page, a, {
      match: (f) => f.event === 'welcome' && f.payload.username === 'alice',
    });

    await send(page, a, { event: 'chat', payload: { text: 'hi' } });
    await page.waitForFunction(
      ([sid]) =>
        ((window.__wskitFrames!(sid as string) ?? []) as WireFrame[]).filter(
          (f) => f.event === 'welcome',
        ).length >= 2,
      [a],
    );
  });

  test('group.request returns a value via correlation id', async ({ page }, testInfo) => {
    const room = `gfs-req-${testInfo.testId}-${Date.now()}`;
    const a = await connect(page, { path: WS_PATH, username: 'alice', room: room });
    await waitForFrame(page, a, { match: (f) => f.event === 'welcome' });

    await send(page, a, {
      event: 'lookup',
      payload: { id: 'abc' },
      __wskit: { correlationId: 'c1' },
    });
    const res = await waitForFrame(page, a, {
      match: (f) => f.event === 'lookup' && f.__wskit?.correlationId === 'c1',
    });
    expect(res.payload.found).toBe(true);
    expect(res.payload.hit).toBe('abc');
    expect(res.payload.tag).toBe('group');
  });

  test('group.stream yields chunks', async ({ page }, testInfo) => {
    const room = `gfs-stream-${testInfo.testId}-${Date.now()}`;
    const a = await connect(page, { path: WS_PATH, username: 'alice', room: room });
    await waitForFrame(page, a, { match: (f) => f.event === 'welcome' });

    await send(page, a, { event: 'feed', payload: {}, __wskit: { streamId: 'feed-1' } });
    await waitForFrame(page, a, {
      match: (f) => f.event === '__streamEnd__' && f.__wskit?.streamId === 'feed-1',
    });
    const chunks = (await frames(page, a))
      .filter((f) => f.event === 'feed' && typeof f.payload.idx === 'number')
      .map((f) => f.payload.idx as number);
    expect(chunks).toEqual([1, 2, 3]);
  });

  test('group.resumableStream and group.recordedStream both work', async ({ page }, testInfo) => {
    const room = `gfs-streams-${testInfo.testId}-${Date.now()}`;
    const a = await connect(page, { path: WS_PATH, username: 'alice', room: room });
    await waitForFrame(page, a, { match: (f) => f.event === 'welcome' });

    await send(page, a, { event: 'paginate', payload: {}, __wskit: { streamId: 'p-1' } });
    await waitForFrame(page, a, {
      match: (f) => f.event === '__streamEnd__' && f.__wskit?.streamId === 'p-1',
    });
    const rows = (await frames(page, a))
      .filter((f) => f.event === 'paginate' && typeof f.payload.row === 'number')
      .map((f) => f.payload.row as number);
    expect(rows).toEqual([1, 2, 3, 4, 5]);

    await send(page, a, { event: 'tokens', payload: {}, __wskit: { streamId: 't-1' } });
    await waitForFrame(page, a, {
      match: (f) => f.event === '__streamEnd__' && f.__wskit?.streamId === 't-1',
    });
    const toks = (await frames(page, a))
      .filter((f) => f.event === 'tokens' && typeof f.payload.token === 'string')
      .map((f) => f.payload.token as string);
    expect(toks).toEqual(['tok-1', 'tok-2', 'tok-3', 'tok-4', 'tok-5']);
  });

  test('group.scheduled fires and records into SQL', async ({ page }, testInfo) => {
    const room = `gfs-sched-${testInfo.testId}-${Date.now()}`;
    const a = await connect(page, { path: WS_PATH, username: 'alice', room: room });
    await waitForFrame(page, a, { match: (f) => f.event === 'welcome' });

    await send(page, a, { event: 'start-tick', payload: {} });

    await expect
      .poll(
        async () => {
          await send(page, a, { event: 'check-scheduled', payload: {} });
          const found = (await frames(page, a))
            .filter((f) => f.event === 'scheduled-marker')
            .at(-1);
          return found ? (found.payload.tickCount as number) : 0;
        },
        { timeout: 10_000 },
      )
      .toBeGreaterThanOrEqual(1);
  });

  test('group.channel broadcasts send-msg as room-msg to subscribers', async ({
    page,
  }, testInfo) => {
    const room = `gfs-ch-${testInfo.testId}-${Date.now()}`;
    const a = await connect(page, { path: WS_PATH, username: 'alice', room: room });
    await waitForFrame(page, a, { match: (f) => f.event === 'welcome' });
    await send(page, a, { event: '__subscribe__', payload: {}, __wskit: { channel: 'rooms' } });
    await waitForFrame(page, a, { match: (f) => f.event === '__subscribeOk__' });

    await send(page, a, {
      event: 'send-msg',
      payload: { text: 'hello room' },
      __wskit: { channel: 'rooms' },
    });
    const msg = await waitForFrame(page, a, {
      match: (f) => f.event === 'room-msg' && f.payload.text === 'hello room',
    });
    expect(msg.payload.from).toBe('alice');
  });

  test('group.intercept (pre) fires for every message', async ({ page }, testInfo) => {
    const room = `gfs-ipre-${testInfo.testId}-${Date.now()}`;
    const a = await connect(page, { path: WS_PATH, username: 'alice', room: room });
    await waitForFrame(page, a, { match: (f) => f.event === 'welcome' });

    await send(page, a, { event: 'chat', payload: { text: 'pre-check' } });
    const marker = await waitForFrame(page, a, {
      match: (f) => f.event === 'pre-intercept-marker' && f.payload.event === 'chat',
    });
    expect(marker.payload.event).toBe('chat');
  });

  test('group.intercept with matches() narrowing fires per-event with typed payload', async ({
    page,
  }, testInfo) => {
    const room = `gfs-ipost-${testInfo.testId}-${Date.now()}`;
    const a = await connect(page, { path: WS_PATH, username: 'alice', room: room });
    await waitForFrame(page, a, { match: (f) => f.event === 'welcome' });

    await send(page, a, { event: 'chat', payload: { text: 'post-check' } });
    const marker = await waitForFrame(page, a, {
      match: (f) => f.event === 'post-intercept-marker' && f.payload.text === 'post-check',
    });
    expect(marker.payload.text).toBe('post-check');
  });

  test('group.rateLimit on chat — second call returns rate-limited _error', async ({
    page,
  }, testInfo) => {
    const room = `gfs-rl-${testInfo.testId}-${Date.now()}`;
    const a = await connect(page, { path: WS_PATH, username: 'alice', room: room });
    await waitForFrame(page, a, { match: (f) => f.event === 'welcome' });

    await send(page, a, { event: 'chat', payload: { text: 'one' } });
    await send(page, a, { event: 'chat', payload: { text: 'two' } });
    const err = await waitForFrame(page, a, { match: (f) => f.event === '__error__' });
    expect(err.payload.code).toBe('rate-limited');
  });

  test('group.customReplay round-trips a stored marker', async ({ page }, testInfo) => {
    const room = `gfs-replay-${testInfo.testId}-${Date.now()}`;
    const a = await connect(page, { path: WS_PATH, username: 'alice', room: room });
    await waitForFrame(page, a, { match: (f) => f.event === 'welcome' });

    await send(page, a, { event: 'emit-replay-marker', payload: { note: 'stored-1' } });
    await waitForFrame(page, a, {
      match: (f) => f.event === 'replay-marker' && f.payload.note === 'stored-1',
    });

    const b = await connect(page, { path: WS_PATH, username: 'bob', room: room });
    await waitForFrame(page, b, { match: (f) => f.event === 'welcome' });
    await send(page, b, { event: '__replay__', payload: { lastKnownSeq: 0 }, __wskit: {} });

    await waitForFrame(page, b, {
      match: (f) => f.event === 'replay-marker' && f.payload.note === 'stored-1',
    });
  });

  test('group.onConnect sends welcome and group.onDisconnect writes to SQL', async ({
    page,
  }, testInfo) => {
    const room = `gfs-life-${testInfo.testId}-${Date.now()}`;

    const a = await connect(page, { path: WS_PATH, username: 'alice', room: room });
    await waitForFrame(page, a, {
      match: (f) => f.event === 'welcome' && f.payload.username === 'alice',
    });
    await closeSocket(page, a);
    await page.waitForTimeout(300);

    const b = await connect(page, { path: WS_PATH, username: 'alice', room: room });
    await waitForFrame(page, b, { match: (f) => f.event === 'welcome' });
    await send(page, b, {
      event: 'check-disconnect-log',
      payload: { identity: 'alice' },
    });
    const goodbye = await waitForFrame(page, b, { match: (f) => f.event === 'goodbye' });
    expect(goodbye.payload.username).toMatch(/^seen:[1-9]\d*$/);
  });

  test('group.onInit ran at boot — check-init replies with ran=1', async ({ page }, testInfo) => {
    const room = `gfs-init-${testInfo.testId}-${Date.now()}`;
    const a = await connect(page, { path: WS_PATH, username: 'alice', room: room });
    await waitForFrame(page, a, { match: (f) => f.event === 'welcome' });

    await send(page, a, { event: 'check-init', payload: {} });
    const marker = await waitForFrame(page, a, { match: (f) => f.event === 'init-marker' });
    expect(marker.payload.ran).toBe(1);
  });

  test('group.onError and onValidationError fire', async ({ page }, testInfo) => {
    const room = `gfs-err-${testInfo.testId}-${Date.now()}`;
    const a = await connect(page, { path: WS_PATH, username: 'alice', room: room });
    await waitForFrame(page, a, { match: (f) => f.event === 'welcome' });

    await send(page, a, { event: 'bang', payload: {} });
    const errMarker = await waitForFrame(page, a, { match: (f) => f.event === 'error-marker' });
    expect(errMarker.payload.event).toBe('bang');
    expect(String(errMarker.payload.msg)).toContain('bang!');

    await send(page, a, {
      event: 'bad-payload',
      payload: { wrong: true } as unknown as Record<string, unknown>,
    });
    const valMarker = await waitForFrame(page, a, {
      match: (f) => f.event === 'validation-marker' && f.payload.event === 'bad-payload',
    });
    expect(valMarker.payload.event).toBe('bad-payload');
  });
});
