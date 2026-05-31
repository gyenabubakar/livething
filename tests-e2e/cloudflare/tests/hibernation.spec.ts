import { expect, test } from '@playwright/test';
import { connect, installRig, send, waitForFrame } from './_ws-rig.ts';

// Note on scope: the hibernation *wake* path (Cloudflare evicts the DO from
// memory while keeping the socket open at the edge, then rebuilds the
// connection from its storage row on the next message) cannot be triggered
// deterministically in `wrangler dev` — miniflare keeps the instance alive, and
// there is no API to force eviction. `ctx.abort()` is NOT a substitute: it
// closes the sockets, so it exercises the reconnect/persistence path on fresh
// sockets, not the same-socket wake restore. So "state survives a wake" is
// covered by @server unit tests (which drive the wake code directly), and the
// durable-storage half is proven by the sequence/persistence/durable-config
// restart tests. What remains genuinely hibernation-specific AND deterministic
// is the connection-quality behavior below.
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
