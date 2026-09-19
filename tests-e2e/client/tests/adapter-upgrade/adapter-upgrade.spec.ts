import { expect, test } from '@playwright/test';

// Conformance: the wire contract for a non-WebSocket request to a /ws route.
// A plain GET (no Upgrade header) must come back as HTTP 426 Upgrade Required,
// the same for every server definition. Pure HTTP — no page or @livething/client needed; the
// request goes through the same /ws proxy the sockets use.
test.describe('adapter upgrade (conformance)', () => {
  test('a plain GET to a /ws route returns HTTP 426', async ({ request }, testInfo) => {
    const res = await request.get(`/ws/incoming?room=au-${testInfo.testId}&username=alice`);
    expect(res.status()).toBe(426);
  });

  test('a plain GET to a streaming route also returns HTTP 426', async ({ request }, testInfo) => {
    const res = await request.get(`/ws/stream-basic?room=au-sb-${testInfo.testId}&username=alice`);
    expect(res.status()).toBe(426);
  });
});
