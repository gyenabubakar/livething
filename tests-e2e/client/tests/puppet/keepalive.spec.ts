import { expect, test } from '@playwright/test';

test('measures latency and reports excellent quality when the server pongs', async ({
  page,
}, testInfo) => {
  await page.goto(`/tests/puppet/index.html?path=pong&room=${testInfo.testId}&keepalive=1`);
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('state')).toHaveText('open');

  await expect(page.getByTestId('latency')).toHaveText(/^\d+(\.\d+)?$/, { timeout: 5_000 });
  await expect(page.getByTestId('quality')).toHaveText('excellent', { timeout: 5_000 });
});

test('force-closes the socket after missed pongs when the server is silent', async ({
  page,
}, testInfo) => {
  await page.goto(`/tests/puppet/index.html?path=silent&room=${testInfo.testId}&keepalive=1`);
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('state')).toHaveText('open');

  // No pongs ever arrive → keepalive force-closes after maxMissedPongs.
  await expect(page.getByTestId('state')).toHaveText('closed', { timeout: 5_000 });
});

// Regression for the server→client keepalive bug. The wskit server sends a bare
// "ping" TEXT frame; the client core must answer with a bare "pong" — and it
// must do so WITHOUT the keepalive primitive, because the engine (not the
// primitive) owns that auto-reply (see client keepalive.ts: "the client still
// replies to the server's pings"). The bug: the client ran JSON.parse on the
// frame first, threw on the un-parseable "ping", and dropped it — so it never
// ponged, the server never recorded a pong, and otherwise-healthy sockets got
// idle-closed. The puppet only emits `echoed: pong-confirmed` after it receives
// a RAW "pong" (the exact form server messages.ts records), so this passes only
// when the client answers a raw ping with a raw pong.
test('core client auto-replies to the server\'s raw "ping" with a raw "pong" (no keepalive primitive)', async ({
  page,
}, testInfo) => {
  await page.goto(`/tests/puppet/index.html?path=server-ping&room=${testInfo.testId}`);
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('state')).toHaveText('open');

  await expect(page.getByTestId('last-payload')).toHaveText(/pong-confirmed/, { timeout: 5_000 });
});
