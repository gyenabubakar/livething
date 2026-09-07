import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { closeSocket, frames, openMember, send, waitForFrame } from './_inbox-rig.ts';
import type { Frame } from './_inbox-rig.ts';

// Raw-wire conformance for the `lastSeen()` capability against the real
// Cloudflare worker. It stamps a durable per-identity timestamp on connect and
// on disconnect (the default `track: 'connection'`) and exposes `ctx.lastSeen`
// (`at` / `atMany` / `online`) to any connection, including one asking about an
// identity other than itself.
//
// `askLastSeen` may be asked about the same identity twice in one test (before
// and after a disconnect), so it counts matching answers already in the frame
// log and waits for one more past that count, never re-matching a stale answer.

async function askLastSeen(page: Page, identity: string): Promise<Frame> {
  function match(f: Frame): boolean {
    return f.event === 'last-seen-answer' && f.payload.identity === identity;
  }

  const already = (await frames(page)).filter(match).length;
  await send(page, { event: 'ask-last-seen', payload: { identity }, __wskit: {} });
  await expect
    .poll(async () => (await frames(page)).filter(match).length, { timeout: 15_000 })
    .toBeGreaterThan(already);

  return (await frames(page)).filter(match).at(-1)!;
}

async function askLastSeenMany(page: Page, identities: string[]): Promise<Frame> {
  await send(page, { event: 'ask-last-seen-many', payload: { identities }, __wskit: {} });
  return waitForFrame(page, (f) => f.event === 'last-seen-many-answer');
}

test.describe('lastSeen() (raw wire)', () => {
  test('connect stamps a timestamp and marks the identity online', async ({
    browser,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const alice = await openMember(browser, { path: '/last-seen', room, username: 'alice' });

    const answer = await askLastSeen(alice.page, 'alice');
    expect(typeof answer.payload.at).toBe('number');
    expect(answer.payload.online).toBe(true);

    await alice.close();
  });

  test('another connection can query an identity, and disconnect flips it offline', async ({
    browser,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const alice = await openMember(browser, { path: '/last-seen', room, username: 'alice' });
    const bob = await openMember(browser, { path: '/last-seen', room, username: 'bob' });

    const whileOnline = await askLastSeen(bob.page, 'alice');
    expect(typeof whileOnline.payload.at).toBe('number');
    expect(whileOnline.payload.online).toBe(true);

    await closeSocket(alice.page);
    // Give the disconnect hook time to stamp before reading it back.
    await bob.page.waitForTimeout(300);

    const afterDisconnect = await askLastSeen(bob.page, 'alice');
    expect(typeof afterDisconnect.payload.at).toBe('number');
    expect(afterDisconnect.payload.online).toBe(false);

    await bob.close();
  });

  test('atMany reads several identities in one call', async ({ browser }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const alice = await openMember(browser, { path: '/last-seen', room, username: 'alice' });
    const bob = await openMember(browser, { path: '/last-seen', room, username: 'bob' });

    const answer = await askLastSeenMany(bob.page, ['alice', 'bob', 'carol']);
    const entries = answer.payload.entries as Record<string, number>;
    expect(typeof entries.alice).toBe('number');
    expect(typeof entries.bob).toBe('number');
    expect('carol' in entries).toBe(false);

    await alice.close();
    await bob.close();
  });
});
