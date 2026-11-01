import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { closeSocket, connect, frames, installRig, send, waitForFrame } from './_ws-rig.ts';
import type { WireFrame } from './_ws-rig.ts';

const PROBE = '__e2e:probe::';

async function openProbe(page: Page, room: string) {
  await page.goto('/');
  await installRig(page);
  return connect(page, { path: '/ws/plugins', username: 'probe-user', room });
}

function onlineVias(all: WireFrame[]) {
  return all.filter((f) => f.event === `${PROBE}user-online`).map((f) => f.payload.via);
}

// Every per-connection send a plugin makes must carry its namespace, so the
// frame matches the plugin's namespaced `emits(...)` declaration instead of
// failing as an undeclared event.
test.describe('plugins handler — plugin ctx sends are namespaced', () => {
  test('ctx.connections.get(ref).send', async ({ page }, testInfo) => {
    const id = await openProbe(page, `test-${testInfo.testId}`);
    await send(page, id, { event: `${PROBE}via-connections`, payload: {} });

    await waitForFrame(page, id, { match: (f) => f.event === `${PROBE}user-online` });
    const all = await frames(page, id);
    expect(onlineVias(all)).toEqual(['connections']);
    expect(all.some((f) => f.event === '__error__')).toBe(false);
    await closeSocket(page, id);
  });

  test('ctx.users.get(id).broadcast and ctx.user.broadcast', async ({ page }, testInfo) => {
    const id = await openProbe(page, `test-${testInfo.testId}`);
    await send(page, id, { event: `${PROBE}via-users`, payload: {} });

    await expect(async () => {
      expect(onlineVias(await frames(page, id))).toEqual(['users', 'user']);
    }).toPass({ timeout: 10_000 });
    expect((await frames(page, id)).some((f) => f.event === '__error__')).toBe(false);
    await closeSocket(page, id);
  });

  test('tag group and tag ref broadcast', async ({ page }, testInfo) => {
    const id = await openProbe(page, `test-${testInfo.testId}`);
    await send(page, id, { event: `${PROBE}via-tags`, payload: {} });

    await expect(async () => {
      expect(onlineVias(await frames(page, id))).toEqual(['tag-group', 'tag-ref']);
    }).toPass({ timeout: 10_000 });
    expect((await frames(page, id)).some((f) => f.event === '__error__')).toBe(false);
    await closeSocket(page, id);
  });
});

// A plugin's onError reports back through `error-seen`, plus `validation-seen`
// for a `ValidationFailed` error. It must stay silent for the app's failures and for
// another plugin's failures, and see its own events under the short name.
test.describe('plugins handler — plugin error hooks see only their own failures', () => {
  function hookFrames(all: WireFrame[]) {
    return all.filter(
      (f) => f.event === `${PROBE}error-seen` || f.event === `${PROBE}validation-seen`,
    );
  }

  test('app and other-plugin failures do not reach the plugin hooks', async ({
    page,
  }, testInfo) => {
    const id = await openProbe(page, `test-${testInfo.testId}`);

    await send(page, id, { event: 'app-fail', payload: {} });
    await send(page, id, { event: 'insert-record', payload: { name: 1 } });
    await send(page, id, { event: '__e2e:feed::trigger-plugin-failure', payload: {} });

    // Each failure answers with its own __error__ frame; wait for all three.
    await expect(async () => {
      const errors = (await frames(page, id)).filter((f) => f.event === '__error__');
      expect(errors.length).toBeGreaterThanOrEqual(3);
    }).toPass({ timeout: 10_000 });
    await page.waitForTimeout(200);

    expect(hookFrames(await frames(page, id))).toEqual([]);
    await closeSocket(page, id);
  });

  test('the plugin hooks run for its own failures with the short event name', async ({
    page,
  }, testInfo) => {
    const id = await openProbe(page, `test-${testInfo.testId}`);

    await send(page, id, { event: `${PROBE}fail`, payload: {} });
    await waitForFrame(page, id, { match: (f) => f.event === `${PROBE}error-seen` });

    await send(page, id, { event: `${PROBE}strict`, payload: { n: 'not-a-number' } });
    await waitForFrame(page, id, { match: (f) => f.event === `${PROBE}validation-seen` });

    await expect(async () => {
      expect(hookFrames(await frames(page, id)).map((f) => [f.event, f.payload.event])).toEqual([
        [`${PROBE}error-seen`, 'fail'],
        [`${PROBE}validation-seen`, 'strict'],
        [`${PROBE}error-seen`, 'strict'],
      ]);
    }).toPass({ timeout: 10_000 });
    await closeSocket(page, id);
  });
});
