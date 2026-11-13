import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { hash, pattern } from '../binary/bytes.ts';

// Conformance: @livething/client's uploads() against the real LiveThing `uploads` server
// definition. Adapter-oblivious — it talks to whatever server the run
// booted over the /ws proxy. Each reply carries the server's hash of the stored bytes.
const KiB = 1024;
const PHOTOS = [
  { photoId: 'photo_1', size: 70_000, seed: 11 },
  { photoId: 'photo_2', size: 30_000, seed: 12 },
  { photoId: 'photo_3', size: 120_000, seed: 13 },
  { photoId: 'photo_4', size: 5_000, seed: 14 },
];

interface Member {
  room: string;
  username?: string;
  seed?: number;
  uploadId?: string;
  attachment?: string;
}

async function open(page: Page, member: Member): Promise<void> {
  const query = new URLSearchParams({
    room: member.room,
    username: member.username ?? 'amara',
    seed: String(member.seed ?? 1),
  });
  if (member.uploadId) query.set('uploadId', member.uploadId);
  if (member.attachment) query.set('attachment', member.attachment);
  await page.goto(`/tests/uploads/index.html?${query.toString()}`);
  await expect(page.getByTestId('app-ready')).toHaveText('yes');

  await page.getByTestId('connect').click();
  await expect(page.getByTestId('status')).toHaveText('open');
}

async function reply(page: Page): Promise<Record<string, unknown>> {
  await expect(page.getByTestId('reply')).not.toHaveText('', { timeout: 20_000 });
  return JSON.parse((await page.getByTestId('reply').textContent())!);
}

async function progress(page: Page): Promise<number> {
  return Number((await page.getByTestId('progress').textContent()) || '0');
}

test.describe('uploads (conformance)', () => {
  for (const [scenario, id, file] of [
    ['upload-blob', 'att_blob', pattern(300_000, 1)],
    ['upload-bytes', 'att_bytes', pattern(200_000, 1)],
    ['upload-iterable', 'att_iter', pattern(200_000, 1)],
  ] as const) {
    test(`${scenario}: sends every byte, reports progress, and resolves with the reply`, async ({
      page,
    }, testInfo) => {
      await open(page, { room: `cl-upl-${scenario}-${testInfo.testId}` });
      await page.getByTestId(scenario).click();

      expect(await reply(page)).toEqual({
        attachmentId: id,
        size: file.byteLength,
        hash: hash(file),
        resumedFrom: 0,
      });
      expect(await progress(page)).toBe(file.byteLength);
      await expect(page.getByTestId('errors')).toHaveText('');
    });
  }

  test('an upload that is never started sends nothing', async ({ page }, testInfo) => {
    await open(page, { room: `cl-upl-lazy-${testInfo.testId}` });
    await page.getByTestId('lazy').click();
    await expect(page.getByTestId('lazy-sent')).toHaveText('0');
  });

  test('resumes from the last save after the server drops the socket', async ({
    page,
  }, testInfo) => {
    await open(page, { room: `cl-upl-drop-${testInfo.testId}` });
    await page.getByTestId('upload-slow').click();
    await expect.poll(() => progress(page)).toBeGreaterThanOrEqual(192 * KiB);
    await page.getByTestId('drop').click();

    const info = await reply(page);
    await expect(page.getByTestId('attempts')).toHaveText('1');
    const file = pattern(512 * KiB, 1);
    expect(info).toMatchObject({
      attachmentId: 'att_slow',
      size: file.byteLength,
      hash: hash(file),
    });
    expect(Number(info.resumedFrom)).toBeGreaterThan(0);

    await expect(page.getByTestId('errors')).toHaveText('');
  });

  test('resumes after a page reload with the same uploadId', async ({ page }, testInfo) => {
    const member = { room: `cl-upl-reload-${testInfo.testId}`, uploadId: 'up-reload' };
    await open(page, member);
    await page.getByTestId('upload-slow').click();
    await expect.poll(() => progress(page)).toBeGreaterThanOrEqual(192 * KiB);

    // The page goes away mid-upload; a new page starts the same upload again.
    await open(page, member);
    await page.getByTestId('upload-slow').click();
    const info = await reply(page);
    const file = pattern(512 * KiB, 1);
    expect(info).toMatchObject({ size: file.byteLength, hash: hash(file) });

    expect(Number(info.resumedFrom)).toBeGreaterThan(0);
  });

  test('a resume with another size rejects with input-mismatch', async ({ page }, testInfo) => {
    const member = { room: `cl-upl-mismatch-${testInfo.testId}`, uploadId: 'up-mismatch' };
    await open(page, member);
    await page.getByTestId('upload-slow').click();
    await expect.poll(() => progress(page)).toBeGreaterThanOrEqual(192 * KiB);

    await open(page, member);
    await page.getByTestId('upload-slow-smaller').click();
    await expect(page.getByTestId('errors')).toHaveText('upload-aborted:input-mismatch');
  });

  test('the same uploadId on a second page takes the upload over', async ({
    browser,
    page,
  }, testInfo) => {
    const member = { room: `cl-upl-takeover-${testInfo.testId}`, uploadId: 'up-takeover' };
    await open(page, member);
    await page.getByTestId('upload-slow').click();
    await expect.poll(() => progress(page)).toBeGreaterThanOrEqual(192 * KiB);

    const second = await browser.newPage();
    await open(second, member);
    await second.getByTestId('upload-slow').click();

    await expect(page.getByTestId('errors')).toHaveText('upload-aborted:taken-over');

    const info = await reply(second);
    const file = pattern(512 * KiB, 1);
    expect(info).toMatchObject({ size: file.byteLength, hash: hash(file) });
    expect(Number(info.resumedFrom)).toBeGreaterThan(0);
    await second.close();
  });

  test('cancel rejects with upload-aborted, and the server discards the upload', async ({
    page,
  }, testInfo) => {
    await open(page, { room: `cl-upl-cancel-${testInfo.testId}`, attachment: 'att_slow' });
    await page.getByTestId('upload-slow').click();
    await expect.poll(() => progress(page)).toBeGreaterThan(0);
    await page.getByTestId('cancel').click();

    await expect(page.getByTestId('errors')).toHaveText('upload-aborted:cancelled');
    await expect
      .poll(async () => {
        await page.getByTestId('check-attachment').click();
        return page.getByTestId('attachment').textContent();
      })
      .toBe(JSON.stringify({ size: 0, hash: hash(new Uint8Array(0)), discarded: 1 }));
  });

  test("rejects with the error the server's run threw", async ({ page }, testInfo) => {
    await open(page, { room: `cl-upl-fail-${testInfo.testId}` });
    await page.getByTestId('upload-failing').click();
    await expect(page.getByTestId('errors')).toHaveText('storage-full');
  });

  test('rejects a file over the limit before sending it', async ({ page }, testInfo) => {
    await open(page, { room: `cl-upl-huge-${testInfo.testId}` });
    await page.getByTestId('upload-too-large').click();
    await expect(page.getByTestId('errors')).toHaveText('upload-aborted:too-large');
    await expect(page.getByTestId('progress')).toHaveText('');
  });

  test('an AsyncIterable cannot resume after a drop', async ({ page }, testInfo) => {
    await open(page, { room: `cl-upl-iter-drop-${testInfo.testId}` });
    await page.getByTestId('upload-iterable-slow').click();
    await expect.poll(() => progress(page)).toBeGreaterThan(0);
    await page.getByTestId('drop').click();

    await expect(page.getByTestId('errors')).toHaveText('upload-aborted:not-resumable', {
      timeout: 15_000,
    });
    await expect(page.getByTestId('attempts')).toHaveText('1');
    await expect(page.getByTestId('reply')).toHaveText('');
  });

  test("a plugin's scoped socket uploads under the plugin's name", async ({ page }, testInfo) => {
    await open(page, { room: `cl-upl-plugin-${testInfo.testId}` });
    await page.getByTestId('upload-plugin').click();

    const file = pattern(150_000, 1);
    expect(await reply(page)).toEqual({ fileId: 'f1', size: file.byteLength, hash: hash(file) });
  });

  test("a plugin's upload rejects with the plugin's own error code", async ({ page }, testInfo) => {
    await open(page, { room: `cl-upl-plugin-full-${testInfo.testId}` });
    await page.getByTestId('upload-plugin-full').click();
    await expect(page.getByTestId('errors')).toHaveText('files-full');
  });

  test('four photos with one caption go up as one upload, and come apart on the server', async ({
    page,
  }, testInfo) => {
    await open(page, { room: `cl-upl-photos-${testInfo.testId}` });
    await page.getByTestId('upload-photos').click();

    expect(await reply(page)).toEqual({
      caption: 'Just an example',
      photos: PHOTOS.map(({ photoId, size, seed }) => ({
        photoId,
        size,
        hash: hash(pattern(size, seed)),
      })),
    });
  });
});
