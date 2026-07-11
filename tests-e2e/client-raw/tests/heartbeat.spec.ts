import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { connect, frames, installRig, rawFrames, sendRaw } from './_ws-rig.ts';

/**
 * The rig needs a page on the worker's origin before it can open a socket.
 * Which page does not matter — these tests talk to the wire directly.
 */
async function openRig(page: Page, room: string) {
  await page.goto(`/protocol-pings?room=${room}`);
  await installRig(page);
}

test.describe('heartbeat hooks — no keepalive() listed', () => {
  test('the server answers a client ping with a pong', async ({ page }, testInfo) => {
    const room = `heartbeat-${testInfo.testId}`;
    await openRig(page, room);
    const sock = await connect(page, { path: '/ws/heartbeat', username: 'alice', room });

    await sendRaw(page, sock, 'ping');

    await expect.poll(async () => (await rawFrames(page, sock)).includes('pong')).toBe(true);
  });

  test('the server never sends a ping of its own', async ({ page }, testInfo) => {
    const room = `heartbeat-${testInfo.testId}`;
    await openRig(page, room);
    const sock = await connect(page, { path: '/ws/heartbeat', username: 'alice', room });

    // Well past the 30s interval the engine used to ping at by default. Kept
    // short enough for a test: any old default would have fired several times.
    await page.waitForTimeout(3_000);

    expect(await rawFrames(page, sock)).not.toContain('ping');
  });

  test('base.onPing fires after the pong reply, with a context for that connection', async ({
    page,
  }, testInfo) => {
    const room = `heartbeat-${testInfo.testId}`;
    await openRig(page, room);
    const sock = await connect(page, { path: '/ws/heartbeat', username: 'alice', room });

    await sendRaw(page, sock, 'ping');

    await expect
      .poll(async () => (await frames(page, sock)).filter((f) => f.event === 'ping-seen').length)
      .toBe(1);

    const raw = await rawFrames(page, sock);
    expect(raw.indexOf('pong')).toBeLessThan(raw.findIndex((f) => f.includes('ping-seen')));

    const seen = (await frames(page, sock)).find((f) => f.event === 'ping-seen')!;
    expect(seen.payload.connectionId).toMatch(/^conn_/);
  });

  test('base.onPong fires when the client sends a pong', async ({ page }, testInfo) => {
    const room = `heartbeat-${testInfo.testId}`;
    await openRig(page, room);
    const sock = await connect(page, { path: '/ws/heartbeat', username: 'alice', room });

    await sendRaw(page, sock, 'pong');

    await expect
      .poll(async () => (await frames(page, sock)).filter((f) => f.event === 'pong-seen').length)
      .toBe(1);
  });

  test('a listed plugin can observe ping / pong too', async ({ page }, testInfo) => {
    const room = `heartbeat-${testInfo.testId}`;
    await openRig(page, room);
    const sock = await connect(page, { path: '/ws/heartbeat', username: 'alice', room });

    await sendRaw(page, sock, 'ping');
    await sendRaw(page, sock, 'pong');

    // The plugin's markers ride under its own namespace on the wire.
    await expect
      .poll(async () =>
        (await frames(page, sock)).some((f) => f.event === '__e2e:heartbeat::plugin-ping-seen'),
      )
      .toBe(true);
    await expect
      .poll(async () =>
        (await frames(page, sock)).some((f) => f.event === '__e2e:heartbeat::plugin-pong-seen'),
      )
      .toBe(true);
  });

  test('a ping does not fire onPong, and a pong does not fire onPing', async ({
    page,
  }, testInfo) => {
    const room = `heartbeat-${testInfo.testId}`;
    await openRig(page, room);
    const sock = await connect(page, { path: '/ws/heartbeat', username: 'alice', room });

    await sendRaw(page, sock, 'ping');
    await expect
      .poll(async () => (await frames(page, sock)).some((f) => f.event === 'ping-seen'))
      .toBe(true);

    expect((await frames(page, sock)).some((f) => f.event === 'pong-seen')).toBe(false);

    await sendRaw(page, sock, 'pong');
    await expect
      .poll(async () => (await frames(page, sock)).some((f) => f.event === 'pong-seen'))
      .toBe(true);

    expect((await frames(page, sock)).filter((f) => f.event === 'ping-seen')).toHaveLength(1);
  });

  test('app code has no way to send a ping, so none ever goes out', async ({ page }, testInfo) => {
    const room = `heartbeat-${testInfo.testId}`;
    await openRig(page, room);
    const sock = await connect(page, { path: '/ws/heartbeat', username: 'alice', room });

    // Only `keepalive()` may send a ping: a `pong` carries no id, so a second
    // sender would make keepalive time the wrong ping.
    await sendRaw(page, sock, 'ping');
    await sendRaw(page, sock, 'pong');
    await page.waitForTimeout(1_000);

    expect(await rawFrames(page, sock)).not.toContain('ping');
  });
});

test.describe('heartbeat hooks — keepalive() listed', () => {
  test('the server pings on its own', async ({ page }, testInfo) => {
    const room = `heartbeat-ka-${testInfo.testId}`;
    await openRig(page, room);
    const sock = await connect(page, {
      path: '/ws/heartbeat-keepalive',
      username: 'alice',
      room,
    });

    await expect
      .poll(async () => (await rawFrames(page, sock)).includes('ping'), { timeout: 10_000 })
      .toBe(true);
  });

  test('keepalive records the round-trip before the app onPong runs', async ({
    page,
  }, testInfo) => {
    const room = `heartbeat-ka-${testInfo.testId}`;
    await openRig(page, room);
    const sock = await connect(page, {
      path: '/ws/heartbeat-keepalive',
      username: 'alice',
      room,
    });

    await expect
      .poll(async () => (await rawFrames(page, sock)).includes('ping'), { timeout: 10_000 })
      .toBe(true);

    await sendRaw(page, sock, 'pong');

    await expect
      .poll(async () => (await frames(page, sock)).filter((f) => f.event === 'pong-seen').length, {
        timeout: 10_000,
      })
      .toBeGreaterThan(0);

    const pong = (await frames(page, sock)).find((f) => f.event === 'pong-seen')!;

    // Only true if keepalive's own onPong ran first and measured the round-trip.
    expect(typeof pong.payload.latency).toBe('number');
    expect(pong.payload.latency as number).toBeGreaterThanOrEqual(0);
    expect(['excellent', 'good', 'degraded', 'poor']).toContain(pong.payload.quality);
  });

  test('the server still answers a client ping with a pong', async ({ page }, testInfo) => {
    const room = `heartbeat-ka-${testInfo.testId}`;
    await openRig(page, room);
    const sock = await connect(page, {
      path: '/ws/heartbeat-keepalive',
      username: 'alice',
      room,
    });

    await sendRaw(page, sock, 'ping');

    await expect.poll(async () => (await rawFrames(page, sock)).includes('pong')).toBe(true);
  });
});

test.describe('heartbeat hooks — hibernation enabled', () => {
  test('a client ping is answered by the runtime, so base.onPing never fires', async ({
    page,
  }, testInfo) => {
    const room = `heartbeat-hib-${testInfo.testId}`;
    await openRig(page, room);
    const sock = await connect(page, {
      path: '/ws/heartbeat-hibernation',
      username: 'alice',
      room,
    });

    await sendRaw(page, sock, 'ping');

    await expect.poll(async () => (await rawFrames(page, sock)).includes('pong')).toBe(true);

    // Had the frame reached the handler, the engine's own reply hook would have
    // sent that pong AND `onPing` would have run. The companion test below
    // proves `ctx.send` from a heartbeat hook works here, so a missing
    // `ping-seen` means the hook never ran, not that its frame was lost.
    await page.waitForTimeout(1_000);
    expect((await frames(page, sock)).filter((f) => f.event === 'ping-seen')).toHaveLength(0);
  });

  test('base.onPong still fires, because only ping is auto-answered', async ({
    page,
  }, testInfo) => {
    const room = `heartbeat-hib-${testInfo.testId}`;
    await openRig(page, room);
    const sock = await connect(page, {
      path: '/ws/heartbeat-hibernation',
      username: 'alice',
      room,
    });

    await sendRaw(page, sock, 'pong');

    await expect
      .poll(async () => (await frames(page, sock)).filter((f) => f.event === 'pong-seen').length)
      .toBe(1);
  });
});
