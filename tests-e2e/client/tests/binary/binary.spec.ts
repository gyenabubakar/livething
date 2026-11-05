import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { hash, pattern } from './bytes.ts';

// Conformance: @livething/client's binary() against the real LiveThing `binary` server
// definition (binary spec 9.1). Adapter-oblivious — it talks to whatever server the run
// booted over the /ws proxy. The page shows a hash of the whole bytes it got.
interface Member {
  /** The test's own server room (one Durable Object on Cloudflare). */
  room: string;
  username: string;
  seed?: number;
  /** The `rooms` channel the member joins. */
  channel?: string;
}

async function open(page: Page, member: Member): Promise<void> {
  const { room, username, seed = 1, channel = 'room:general' } = member;
  const query = new URLSearchParams({ room, username, seed: String(seed), channel });
  await page.goto(`/tests/binary/index.html?${query.toString()}`);
  await expect(page.getByTestId('app-ready')).toHaveText('yes');
  await page.getByTestId('connect').click();

  await expect(page.getByTestId('status')).toHaveText('open');
}

function frameLine(from: string, bytes: Uint8Array): string {
  return `${from}:${bytes.byteLength}:${hash(bytes)}`;
}

test.describe('binary (conformance)', () => {
  test('an avatar upload gets its preview back as bytes', async ({ page }, testInfo) => {
    await open(page, { room: `binary-avatar-${testInfo.testId}`, username: 'amara' });

    await page.getByTestId('upload-avatar').click();

    // The server sends back the first 8 bytes of the upload as the preview.
    const preview = pattern(300_000, 1).subarray(0, 8);
    await expect(page.getByTestId('preview')).toHaveText(`image/png 300000 8 ${hash(preview)}`);
    await expect(page.getByTestId('errors')).toHaveText('');
  });

  test('screen frames shared in a room reach the other member of that room only', async ({
    browser,
  }, testInfo) => {
    const room = `binary-screen-${testInfo.testId}`;
    const amara = await browser.newPage();
    const kofi = await browser.newPage();
    const priya = await browser.newPage();
    await open(amara, { room, username: 'amara', seed: 1 });

    await open(kofi, { room, username: 'kofi', seed: 50 });
    await open(priya, { room, username: 'priya', seed: 90, channel: 'room:design' });

    for (const member of [amara, kofi, priya]) {
      await member.getByTestId('join-room').click();
      await expect(member.getByTestId('joined')).toHaveText('yes');
    }

    await amara.getByTestId('share-frames').click();
    await expect(amara.getByTestId('shared')).toHaveText('yes');

    const sent = [0, 1, 2].map((i) => frameLine('amara', pattern(100_000 + i, 1 + i)));
    await expect(kofi.getByTestId('frames')).toHaveText(sent.join('|'));
    await expect(amara.getByTestId('frames')).toHaveText('');
    await expect(priya.getByTestId('frames')).toHaveText('');
    for (const member of [kofi, priya]) {
      await expect(member.getByTestId('errors')).toHaveText('');
    }

    await Promise.all([amara.close(), kofi.close(), priya.close()]);
  });
});
