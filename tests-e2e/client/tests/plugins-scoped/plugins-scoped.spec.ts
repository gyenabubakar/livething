import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// Conformance: @wskit/client driving the real `plugins` server definition through a CLIENT
// PLUGIN (the scoped model). Proves the scoped socket round-trips every verb over
// the real wire under the plugin's namespace, and that the plugin owns that
// namespace — a raw top-level listener for a plugin frame never fires.
async function open(page: Page, room: string, username = 'alice'): Promise<void> {
  await page.goto(`/tests/plugins-scoped/index.html?room=${room}&username=${username}`);
  await expect(page.getByTestId('app-ready')).toHaveText('yes');
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('status')).toHaveText('open');
}

test.describe('plugins — scoped client plugin (conformance)', () => {
  test('scoped send/on round-trips, and the app never sees the plugin frame', async ({
    page,
  }, testInfo) => {
    await open(page, `sc-hello-${testInfo.testId}`);
    await page.getByTestId('hello').click();
    // The plugin's on('welcome') receives __e2e:feed::welcome.
    await expect.poll(async () => page.getByTestId('welcome').textContent()).toBe('alice');
    // The raw top-level listener for the same wire name never fired.
    await expect(page.getByTestId('raw-welcome')).toHaveText('');
  });

  test('scoped request returns the plugin response', async ({ page }, testInfo) => {
    await open(page, `sc-echo-${testInfo.testId}`);
    await page.getByTestId('echo').click();
    await expect.poll(async () => page.getByTestId('echo-result').textContent()).toBe('hello');
  });

  test('scoped request rejection surfaces the plain plugin error code', async ({
    page,
  }, testInfo) => {
    await open(page, `sc-echo-fail-${testInfo.testId}`);
    await page.getByTestId('echo-fail').click();
    // The server throws `__e2e:feed::room-full`; the client plugin strips the
    // namespace so the app author catches the plain `room-full`.
    await expect.poll(async () => page.getByTestId('echo-error').textContent()).toBe('room-full');
  });

  test('scoped durable stream delivers chunks over the wire', async ({ page }, testInfo) => {
    await open(page, `sc-feed-${testInfo.testId}`);
    await page.getByTestId('stream-feed').click();
    await expect.poll(async () => page.getByTestId('feed-rows').textContent()).toBe('1,2,3,4,5');
  });

  test('scoped plain stream delivers chunks over the wire', async ({ page }, testInfo) => {
    await open(page, `sc-plain-${testInfo.testId}`);
    await page.getByTestId('stream-plain').click();
    await expect.poll(async () => page.getByTestId('plain-rows').textContent()).toBe('1,2,3');
  });

  test('scoped recorded stream delivers chunks over the wire', async ({ page }, testInfo) => {
    await open(page, `sc-rec-${testInfo.testId}`);
    await page.getByTestId('stream-recorded').click();
    await expect.poll(async () => page.getByTestId('recorded-rows').textContent()).toBe('1,2,3');
  });

  test('scoped channel subscribes and delivers its broadcast', async ({ page }, testInfo) => {
    await open(page, `sc-room-${testInfo.testId}`);
    await page.getByTestId('join-room').click();
    await expect.poll(async () => page.getByTestId('joined').textContent()).toBe('joined');
  });

  test('scoped stream nudge reaches the server (nudge event is namespaced)', async ({
    page,
  }, testInfo) => {
    await open(page, `sc-nudge-${testInfo.testId}`);
    await page.getByTestId('nudge').click();
    // The server registers the nudge under `__e2e:feed::boost`; the nudge only
    // resolves ('ok') if the client sent that namespaced event, not a bare `boost`.
    await expect.poll(async () => page.getByTestId('nudge-result').textContent()).toBe('ok');
  });

  test('scoped channel subscribe rejection surfaces the plain plugin error code', async ({
    page,
  }, testInfo) => {
    await open(page, `sc-locked-${testInfo.testId}`, 'blocked');
    await page.getByTestId('join-room-fail').click();
    // The server's channel `check` throws `__e2e:feed::room-full`; the client
    // plugin strips the namespace so the app catches the plain `room-full`.
    await expect
      .poll(async () => page.getByTestId('subscribe-error').textContent())
      .toBe('room-full');
  });

  test('scoped channel send reaches the server (outgoing child event is namespaced)', async ({
    page,
  }, testInfo) => {
    await open(page, `sc-chat-${testInfo.testId}`);
    await page.getByTestId('join-room').click();
    await expect.poll(async () => page.getByTestId('joined').textContent()).toBe('joined');
    // Send on the plugin channel; the server's `chat` handler echoes `said` back.
    // If the outgoing `chat` were not namespaced, the server would never match it
    // and `said` would never arrive.
    await page.getByTestId('chat').click();
    await expect.poll(async () => page.getByTestId('said').textContent()).toBe('hey room');
  });

  test('plugin channel ping and pong round-trip as namespaced user events', async ({
    page,
  }, testInfo) => {
    await open(page, `sc-channel-heartbeat-${testInfo.testId}`);
    await page.getByTestId('join-room').click();
    await expect.poll(async () => page.getByTestId('joined').textContent()).toBe('joined');

    await page.getByTestId('channel-ping').click();
    await expect.poll(async () => page.getByTestId('said').textContent()).toBe('ping');

    await page.getByTestId('channel-pong').click();
    await expect.poll(async () => page.getByTestId('said').textContent()).toBe('pong');
  });

  test('scoped dynamic-family channel addresses a specific member', async ({ page }, testInfo) => {
    await open(page, `sc-thread-${testInfo.testId}`);
    await page.getByTestId('join-thread').click();
    // The server echoes the concrete member it saw — proving thread:general was
    // addressed, not one shared channel.
    await expect.poll(async () => page.getByTestId('posted').textContent()).toBe('general');
  });

  test('scoped onServerError matches the declared plugin code and filters other codes', async ({
    page,
  }, testInfo) => {
    await open(page, `sc-plugin-error-${testInfo.testId}`);
    await page.getByTestId('trigger-plugin-failure').click();
    await expect(page.getByTestId('plugin-error-code')).toHaveText('plugin-failure');
    await expect(page.getByTestId('plugin-error-detail')).toHaveText('plugin wire is alive');
    await expect(page.getByTestId('room-full-error-code')).toHaveText('');

    await page.getByTestId('trigger-room-full-error').click();
    await expect(page.getByTestId('room-full-error-code')).toHaveText('room-full');
    await expect(page.getByTestId('plugin-error-detail')).toHaveText('plugin wire is alive');
  });
});
