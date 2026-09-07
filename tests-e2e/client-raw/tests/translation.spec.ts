import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { connect, installRig, rawFrames, sendRaw } from './_ws-rig.ts';

type ForeignReply = { type: 'message'; name: string; body: unknown };

async function waitForRawFrame(
  page: Page,
  id: string,
  match: (frame: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    for (const raw of await rawFrames(page, id)) {
      const frame = JSON.parse(raw) as Record<string, unknown>;
      if (match(frame)) return frame;
    }

    await page.waitForTimeout(50);
  }

  throw new Error('timed out waiting for frame');
}

async function closeAfterForeignFrame(
  page: Page,
  { path, room, frame }: { path: string; room: string; frame: Record<string, unknown> },
): Promise<number> {
  return page.evaluate(
    async ({ currentPath, currentRoom, currentFrame }) =>
      new Promise<number>((resolve, reject) => {
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(
          `${protocol}//${location.host}${currentPath}?username=alice&room=${encodeURIComponent(currentRoom)}`,
        );
        ws.onopen = () => ws.send(JSON.stringify(currentFrame));
        ws.onclose = (event) => resolve(event.code);
        ws.onerror = () => reject(new Error('WebSocket failed'));

        setTimeout(() => reject(new Error('timed out waiting for close')), 5_000);
      }),
    { currentPath: path, currentRoom: room, currentFrame: frame },
  );
}

test.describe('translation', () => {
  test('translates both directions and creates state for each connection', async ({
    page,
  }, testInfo) => {
    await page.goto('/');
    await installRig(page);
    const room = `translation-${testInfo.testId}`;
    const alice = await connect(page, { path: '/ws/translation', username: 'alice', room });
    const bob = await connect(page, { path: '/ws/translation', username: 'bob', room });

    await sendRaw(
      page,
      alice,
      JSON.stringify({ type: 'send', name: 'echo', body: { text: 'one' } }),
    );
    await expect(waitForRawFrame(page, alice, (frame) => frame.name === 'heard')).resolves.toEqual({
      type: 'message',
      name: 'heard',
      body: { text: 'one', translatorSequence: 1 },
    } satisfies ForeignReply);

    await sendRaw(
      page,
      alice,
      JSON.stringify({ type: 'send', name: 'echo', body: { text: 'two' } }),
    );
    await expect(
      waitForRawFrame(
        page,
        alice,
        (frame) => (frame.body as { text?: string } | undefined)?.text === 'two',
      ),
    ).resolves.toEqual({
      type: 'message',
      name: 'heard',
      body: { text: 'two', translatorSequence: 2 },
    } satisfies ForeignReply);

    await sendRaw(
      page,
      bob,
      JSON.stringify({ type: 'send', name: 'echo', body: { text: 'fresh' } }),
    );
    await expect(waitForRawFrame(page, bob, (frame) => frame.name === 'heard')).resolves.toEqual({
      type: 'message',
      name: 'heard',
      body: { text: 'fresh', translatorSequence: 1 },
    } satisfies ForeignReply);
  });

  test('translates WSKit protocol errors on the outbound path', async ({ page }, testInfo) => {
    await page.goto('/');
    await installRig(page);
    const id = await connect(page, {
      path: '/ws/translation',
      username: 'alice',
      room: `translation-error-${testInfo.testId}`,
    });

    await sendRaw(page, id, JSON.stringify({ type: 'send', name: 'server-error', body: {} }));
    const error = await waitForRawFrame(page, id, (frame) => frame.name === '__error__');

    expect(error).toEqual({
      type: 'message',
      name: '__error__',
      body: { code: 'foreign-error', detail: { reason: 'translated error' } },
    } satisfies ForeignReply);
  });

  test('closes malformed foreign input with a protocol error', async ({ page }, testInfo) => {
    await page.goto('/');

    await expect(
      closeAfterForeignFrame(page, {
        path: '/ws/translation',
        room: `translation-invalid-${testInfo.testId}`,
        frame: { type: 'send', name: 'echo', body: { text: 42 } },
      }),
    ).resolves.toBe(1002);
  });

  test('closes when inbound translation fails', async ({ page }, testInfo) => {
    await page.goto('/');

    await expect(
      closeAfterForeignFrame(page, {
        path: '/ws/translation',
        room: `translation-inbound-${testInfo.testId}`,
        frame: { type: 'send', name: 'throw', body: {} },
      }),
    ).resolves.toBe(1011);
  });

  test('closes when outbound translation fails', async ({ page }, testInfo) => {
    await page.goto('/');

    await expect(
      closeAfterForeignFrame(page, {
        path: '/ws/translation',
        room: `translation-outbound-${testInfo.testId}`,
        frame: { type: 'send', name: 'outbound-throw', body: {} },
      }),
    ).resolves.toBe(1011);
  });

  test('keeps frames unchanged when both methods return null', async ({ page }, testInfo) => {
    await page.goto('/');
    await installRig(page);
    const id = await connect(page, {
      path: '/ws/translation-pass-through',
      username: 'alice',
      room: `translation-pass-through-${testInfo.testId}`,
    });

    await sendRaw(page, id, JSON.stringify({ event: 'echo', payload: { text: 'unchanged' } }));
    await expect(waitForRawFrame(page, id, (frame) => frame.event === 'heard')).resolves.toEqual({
      event: 'heard',
      payload: { text: 'unchanged' },
      __wskit: {},
    });
  });

  test('leaves outbound frames as WSKit when outbound is omitted', async ({ page }, testInfo) => {
    await page.goto('/');
    await installRig(page);
    const id = await connect(page, {
      path: '/ws/translation-inbound-only',
      username: 'alice',
      room: `translation-inbound-only-${testInfo.testId}`,
    });

    await sendRaw(page, id, JSON.stringify({ type: 'send', text: 'inbound only' }));
    await expect(waitForRawFrame(page, id, (frame) => frame.event === 'heard')).resolves.toEqual({
      event: 'heard',
      payload: { text: 'inbound only' },
      __wskit: {},
    });
  });
});
