import { expect, test } from '@playwright/test';
import { connect, installRig, send, waitForFrame } from './_ws-rig.ts';

// Same-socket wake behavior is covered with Cloudflare's evictDurableObject()
// test API in tests-e2e/server-cloudflare/test/hibernation-wake.test.ts.
test.describe('hibernation', () => {
  test('ctx.quality is null and ctx.latency is null under hibernation', async ({
    page,
  }, testInfo) => {
    const room = `hib-quality-${testInfo.testId}`;
    await page.goto('/hibernation');
    await installRig(page);

    const id = await connect(page, { path: '/ws/hibernation', username: 'alice', room });

    // No keepalive pings are scheduled under hibernation (scheduling a per-
    // connection timer would keep waking the DO), so latency is never measured
    // and quality is suppressed at the context layer.
    await send(page, id, { event: 'probe-conn', payload: {} });

    const frame = await waitForFrame(page, id, {
      match: (f) => f.event === 'conn-info',
      timeoutMs: 5_000,
    });

    expect(frame.payload.quality).toBeNull();
    expect(frame.payload.latency).toBeNull();
  });
});
