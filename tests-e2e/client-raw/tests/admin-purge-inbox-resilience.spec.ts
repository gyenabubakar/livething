import { expect, test } from '@playwright/test';
import { openMember, send, subscribe, waitForFrame } from './_inbox-rig.ts';

test.describe('inbox purge resilience (real Durable Object)', () => {
  test('continues purge after an inbox delete failure', async ({ browser, page }, testInfo) => {
    const room = `purge-inbox-${testInfo.testId}`;
    await page.goto('/');
    const alice = await openMember(browser, { path: '/receipts', room, username: 'alice' });
    const bob = await openMember(browser, { path: '/receipts', room, username: 'bob' });
    await subscribe(alice.page);

    await subscribe(bob.page);

    await send(bob.page, {
      event: 'send-room-msg',
      payload: { text: 'purge-me' },
      metadata: { channel: { name: 'chat' } },
    });
    const message = await waitForFrame(
      alice.page,
      (frame) => frame.event === 'room-msg' && frame.payload.text === 'purge-me',
    );
    const seq = Number(message.metadata?.delivery?.seq);
    await send(alice.page, {
      event: '__received__',
      payload: { receivedThrough: seq },
      metadata: { channel: { name: 'chat' } },
    });
    await expect
      .poll(async () => {
        const response = await page.evaluate(
          async ({ currentRoom, currentSeq }) => {
            const result = await fetch(
              `/ws/receipts/receivers?room=${encodeURIComponent(currentRoom)}&channel=chat&seq=${currentSeq}`,
            );
            return (await result.json()) as { users: string[] };
          },
          { currentRoom: room, currentSeq: seq },
        );
        return response.users;
      })
      .toContain('alice');

    const drop = await page.evaluate(async (currentRoom) => {
      const response = await fetch(
        `/ws/receipts/drop-inbox?room=${encodeURIComponent(currentRoom)}`,
        {
          method: 'POST',
        },
      );
      return response.status;
    }, room);
    expect(drop).toBe(204);

    const aliceClosed = expect
      .poll(() => alice.page.getByTestId('status').textContent(), {
        timeout: 15_000,
      })
      .toBe('disconnected');
    const purge = await page.evaluate(async (currentRoom) => {
      const response = await fetch(`/ws/receipts/purge?room=${encodeURIComponent(currentRoom)}`, {
        method: 'POST',
      });
      return response.status;
    }, room);
    expect(purge).toBe(500);
    await aliceClosed;

    const after = await page.evaluate(
      async ({ currentRoom, currentSeq }) => {
        const result = await fetch(
          `/ws/receipts/receivers?room=${encodeURIComponent(currentRoom)}&channel=chat&seq=${currentSeq}`,
        );
        return (await result.json()) as { users: string[] };
      },
      { currentRoom: room, currentSeq: seq },
    );
    expect(after.users).not.toContain('alice');
    await expect(bob.page.getByTestId('status')).toHaveText('connected');
    await alice.close();
    await bob.close();
  });
});
