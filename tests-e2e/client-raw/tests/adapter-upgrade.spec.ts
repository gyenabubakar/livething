import { expect, test } from '@playwright/test';

// A WebSocket route only speaks the upgrade handshake. A plain GET (no
// Upgrade header) must be answered with HTTP 426 Upgrade Required by the
// adapter, the same way for every server definition — a wire contract any port must meet.
test.describe('adapter upgrade requirement', () => {
  test('plain GET to a WS route returns HTTP 426 (incoming handler)', async ({
    request,
  }, testInfo) => {
    const res = await request.get(`/ws/incoming?room=au-${testInfo.testId}&username=alice`);
    expect(res.status()).toBe(426);
  });

  test('plain GET to a WS route returns HTTP 426 (stream handler)', async ({
    request,
  }, testInfo) => {
    const res = await request.get(`/ws/stream-basic?room=au-sb-${testInfo.testId}&username=alice`);
    expect(res.status()).toBe(426);
  });
});
