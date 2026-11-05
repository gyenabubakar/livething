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
  /** The attachment the page asks for: `att_<n>` is `pattern(<n> * 1000, <n>)`. */
  attachment?: string;
}

async function open(page: Page, member: Member): Promise<void> {
  const { room, username, seed = 1, channel = 'room:general', attachment = 'att_300' } = member;
  const query = new URLSearchParams({ room, username, seed: String(seed), channel, attachment });
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

  test('a binary request gets the thumbnail back as bytes (spec 9.3)', async ({
    page,
  }, testInfo) => {
    await open(page, { room: `binary-thumbnail-${testInfo.testId}`, username: 'amara' });

    await page.getByTestId('get-thumbnail').click();

    const thumbnail = pattern(300_000, 300).subarray(0, 4000);
    await expect(page.getByTestId('thumbnail')).toHaveText(`image/png 4000 ${hash(thumbnail)}`);
    await expect(page.getByTestId('errors')).toHaveText('');
  });

  test('a binary download stream gives every piece, then ends (spec 9.2)', async ({
    page,
  }, testInfo) => {
    await open(page, { room: `binary-download-${testInfo.testId}`, username: 'amara' });

    await page.getByTestId('download-attachment').click();

    // 300 000 bytes in 64 KiB pieces is 5 pieces; the name comes on the first one only.
    await expect(page.getByTestId('download')).toHaveText(
      `att_300.bin 5 300000 ${hash(pattern(300_000, 300))}`,
    );
    await expect(page.getByTestId('errors')).toHaveText('');
  });

  test('breaking out of a binary download cancels it on the server', async ({ page }, testInfo) => {
    await open(page, { room: `binary-cancel-${testInfo.testId}`, username: 'amara' });

    await page.getByTestId('cancel-download').click();

    await expect(page.getByTestId('cancelled')).toHaveText('yes false');
    await expect(page.getByTestId('errors')).toHaveText('');
  });

  test('the server asks the sharer for a picture and sends it to the room', async ({
    browser,
  }, testInfo) => {
    const room = `binary-capture-${testInfo.testId}`;
    const amara = await browser.newPage();
    const kofi = await browser.newPage();
    await open(amara, { room, username: 'amara', seed: 1 });
    await open(kofi, { room, username: 'kofi', seed: 50 });

    for (const member of [amara, kofi]) {
      await member.getByTestId('join-room').click();
      await expect(member.getByTestId('joined')).toHaveText('yes');
    }

    await amara.getByTestId('start-screen-share').click();

    // amara's page answers capture-screen with maxWidth * 40 bytes, seeded with seed + 100.
    await expect(kofi.getByTestId('frames')).toHaveText(
      frameLine('amara', pattern(1280 * 40, 101)),
    );
    for (const member of [amara, kofi]) {
      await expect(member.getByTestId('errors')).toHaveText('');
    }

    await Promise.all([amara.close(), kofi.close()]);
  });

  test('a member who reconnects gets the screen frames it missed from replay, with every byte', async ({
    browser,
  }, testInfo) => {
    const room = `binary-replay-${testInfo.testId}`;
    const amara = await browser.newPage();
    const kofi = await browser.newPage();
    await open(amara, { room, username: 'amara', seed: 1 });
    await open(kofi, { room, username: 'kofi', seed: 50 });

    for (const member of [amara, kofi]) {
      await member.getByTestId('join-room').click();
      await expect(member.getByTestId('joined')).toHaveText('yes');
    }

    await kofi.getByTestId('drop').click();
    await expect(kofi.getByTestId('status')).toHaveText('reconnecting');

    // amara shares while kofi is away, so kofi can only get the frames from replay.
    await amara.getByTestId('share-frames').click();
    await expect(amara.getByTestId('shared')).toHaveText('yes');

    await expect(kofi.getByTestId('status')).toHaveText('open');
    await expect(kofi.getByTestId('reconnects')).not.toHaveText('0');
    const sent = [0, 1, 2].map((i) => frameLine('amara', pattern(100_000 + i, 1 + i)));
    await expect(kofi.getByTestId('frames')).toHaveText(sent.join('|'));
    await expect(kofi.getByTestId('errors')).toHaveText('');

    await Promise.all([amara.close(), kofi.close()]);
  });
});
