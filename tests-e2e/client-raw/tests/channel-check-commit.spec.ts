import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { connect, installRig, send, waitForFrame } from './_ws-rig.ts';

async function openPage(page: Page, testId: string, username = 'testuser') {
  await page.goto(
    `/channel-check-commit?room=test-${testId}&username=${encodeURIComponent(username)}`,
  );
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('status')).toHaveText('connected');
}

test.describe('channel check/commit', () => {
  // ── happy path ────────────────────────────────────────────────────────────

  test('valid token: subscriber is admitted and receives a joined broadcast', async ({
    page,
  }, testInfo) => {
    await openPage(page, testInfo.testId);
    await page.getByTestId('sub-room-member').click();
    await expect(page.getByTestId('subscribe-ok')).toContainText('room');
    // The 'joined' broadcast from onSubscribe confirms the subscriber is fully in the room.
    await expect(page.getByTestId('joined')).toContainText('testuser');
  });

  test('vip token is also admitted (same check path, different role value)', async ({
    page,
  }, testInfo) => {
    await openPage(page, testInfo.testId);
    await page.getByTestId('sub-room-vip').click();
    await expect(page.getByTestId('subscribe-ok')).toContainText('room');
    await expect(page.getByTestId('joined')).toContainText('testuser');
  });

  // ── check rejects ─────────────────────────────────────────────────────────

  test('unknown token: subscribe is rejected', async ({ page }, testInfo) => {
    await openPage(page, testInfo.testId);
    await page.getByTestId('sub-room-unknown').click();
    await expect(page.getByTestId('subscribe-error')).toContainText('room');
    await expect(page.getByTestId('subscribe-ok')).toHaveText('');
  });

  test('missing token: subscribe is rejected', async ({ page }, testInfo) => {
    await openPage(page, testInfo.testId);
    await page.getByTestId('sub-room-no-token').click();
    await expect(page.getByTestId('subscribe-error')).toContainText('room');
    await expect(page.getByTestId('subscribe-ok')).toHaveText('');
  });

  // ── check validator (declared on the contract) ───────────────────────────

  test('check validator: wrong payload type is rejected before check runs', async ({
    page,
  }, testInfo) => {
    // token must be a string — passing a number fails the schema before the check handler runs.
    await openPage(page, testInfo.testId);
    await page.getByTestId('sub-room-bad-token').click();
    await expect(page.getByTestId('subscribe-error')).toContainText('room');
    await expect(page.getByTestId('subscribe-ok')).toHaveText('');
  });

  // ── commit rejects using the typed check result ───────────────────────────

  test('banned role: commit uses the value returned by check to reject the subscriber', async ({
    page,
  }, testInfo) => {
    // check succeeds but returns a banned role. commit sees that and rejects,
    // so the subscriber never enters the room and onSubscribe never fires.
    await openPage(page, testInfo.testId);
    await page.getByTestId('sub-room-banned').click();
    await expect(page.getByTestId('subscribe-error')).toContainText('room');
    await expect(page.getByTestId('subscribe-ok')).toHaveText('');
    await expect(page.getByTestId('joined')).toHaveText('');
  });

  // ── capacity enforcement inside commit ────────────────────────────────────

  test('room full: 3rd subscriber is rejected when the room is at capacity', async ({
    page,
  }, testInfo) => {
    // Two other users join first to fill the room (capacity = 2),
    // then this client tries and should be turned away.
    const room = `cap-${testInfo.testId}`;
    await page.goto(`/channel-check-commit?room=${room}&username=testuser`);
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');

    await page.evaluate(
      async ({ room }) => {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        function open(username: string) {
          return new Promise<WebSocket>((resolve, reject) => {
            const ws = new WebSocket(
              `${proto}//${location.host}/ws/channel-check-commit?username=${encodeURIComponent(username)}&room=${encodeURIComponent(room)}`,
            );
            ws.onopen = () => resolve(ws);
            ws.onerror = (e) => reject(e);
          });
        }

        const a = await open('filler-a');
        const b = await open('filler-b');
        const frame = window.__livethingEncode({
          event: '__subscribe__',
          payload: { token: 'tok-member' },
          metadata: { channel: { name: 'room' } },
        });

        a.send(frame);
        b.send(frame);
        // Wait for both to be fully admitted before the next client tries.
        await new Promise((r) => setTimeout(r, 300));
      },
      { room },
    );

    await page.getByTestId('sub-room-member').click();
    await expect(page.getByTestId('subscribe-error')).toContainText('room');
    await expect(page.getByTestId('subscribe-ok')).toHaveText('');
  });

  // ── check-only channel ────────────────────────────────────────────────────

  test('check-only: subscriber is admitted without a commit hook', async ({ page }, testInfo) => {
    await openPage(page, testInfo.testId);
    await page.getByTestId('sub-check-only').click();
    await expect(page.getByTestId('subscribe-ok')).toContainText('check-only');
    await expect(page.getByTestId('joined')).toContainText('testuser');
  });

  test('check-only: subscriber is rejected when check throws', async ({ page }, testInfo) => {
    await openPage(page, testInfo.testId, 'no-access');
    await page.getByTestId('sub-check-only').click();
    await expect(page.getByTestId('subscribe-error')).toContainText('check-only');
    await expect(page.getByTestId('subscribe-ok')).toHaveText('');
  });

  // ── commit-only channel ───────────────────────────────────────────────────

  test('commit-only: subscriber is admitted without a check hook', async ({ page }, testInfo) => {
    await openPage(page, testInfo.testId);
    await page.getByTestId('sub-commit-only').click();
    await expect(page.getByTestId('subscribe-ok')).toContainText('commit-only');
    await expect(page.getByTestId('joined')).toContainText('testuser');
  });

  test('commit-only: capacity is still enforced with no check hook', async ({ page }, testInfo) => {
    // One other user takes the only available spot, then this client tries.
    const room = `commit-cap-${testInfo.testId}`;
    await page.goto(`/channel-check-commit?room=${room}&username=testuser`);
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');

    await page.evaluate(
      async ({ room }) => {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = await new Promise<WebSocket>((resolve, reject) => {
          const s = new WebSocket(
            `${proto}//${location.host}/ws/channel-check-commit?username=filler&room=${encodeURIComponent(room)}`,
          );
          s.onopen = () => resolve(s);
          s.onerror = (e) => reject(e);
        });
        ws.send(
          window.__livethingEncode({
            event: '__subscribe__',
            payload: null,
            metadata: { channel: { name: 'commit-only' } },
          }),
        );
        await new Promise((r) => setTimeout(r, 200));
      },
      { room },
    );

    await page.getByTestId('sub-commit-only').click();
    await expect(page.getByTestId('subscribe-error')).toContainText('commit-only');
    await expect(page.getByTestId('subscribe-ok')).toHaveText('');
  });

  test('an async commit() is rejected as internal-error and the connection stays alive', async ({
    page,
  }, testInfo) => {
    await page.goto('/channel-check-commit');
    await installRig(page);
    const room = `ccc-async-${testInfo.testId}`;
    const a = await connect(page, { path: '/ws/channel-check-commit', username: 'alice', room });

    // commit() must be synchronous; the engine rejects a returned Promise.
    await send(page, a, {
      event: '__subscribe__',
      payload: null,
      metadata: { channel: { name: 'async-commit' } },
    });
    const err = await waitForFrame(page, a, {
      match: (f) => f.event === '__error__',
      timeoutMs: 3_000,
    });
    expect(err.payload.code).toBe('internal-error');

    // Connection stays alive — a valid subscribe still works afterward.
    await send(page, a, {
      event: '__subscribe__',
      payload: null,
      metadata: { channel: { name: 'check-only' } },
    });
    await waitForFrame(page, a, {
      match: (f) => f.event === '__subscribeOk__' && f.metadata?.channel?.name === 'check-only',
    });
  });
});
