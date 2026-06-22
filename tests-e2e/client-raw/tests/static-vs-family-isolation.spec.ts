import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

type Frame = {
  event: string;
  payload: Record<string, unknown>;
  __wskit?: Record<string, unknown>;
};

async function setupClient(page: Page, username: string, room: string) {
  await page.goto(`/static-vs-family-isolation?room=${room}`);
  await page.getByTestId('username').fill(username);
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('status')).toHaveText('connected');
}

async function send(page: Page, frame: unknown) {
  await page.evaluate((f) => {
    const ws = (window as unknown as { __ws?: WebSocket }).__ws;
    ws?.send(JSON.stringify(f));
  }, frame);
}

async function startCapture(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __ws?: WebSocket; __frames?: Frame[] };
    w.__frames = [];
    const ws = w.__ws!;
    ws.addEventListener('message', (ev) => {
      if (typeof ev.data !== 'string') return;
      w.__frames!.push(JSON.parse(ev.data));
    });
  });
}

async function frames(page: Page): Promise<Frame[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __frames?: Frame[] };
    return (w.__frames ?? []).slice();
  });
}

async function subscribeStatic(page: Page, name: string) {
  await send(page, { event: '__subscribe__', payload: {}, __wskit: { channel: name } });
}

async function subscribeFamily(page: Page, scopeKey: string, name: string) {
  await send(page, {
    event: '__subscribe__',
    payload: {},
    __wskit: { channel: name, channelFamily: scopeKey },
  });
}

async function waitForFrame(page: Page, predicate: (f: Frame) => boolean) {
  await expect
    .poll(async () => (await frames(page)).some(predicate), { timeout: 5_000 })
    .toBe(true);
}

test.describe('static-vs-family-isolation', () => {
  test('members() lists are scoped: static general and family rooms:room:1 do not leak into each other', async ({
    browser,
  }, testInfo) => {
    const room = `svfi-members-${testInfo.testId}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const ctxC = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();
    const c = await ctxC.newPage();

    await setupClient(a, 'alice', room);
    await setupClient(b, 'bob', room);
    await setupClient(c, 'carol', room);
    await startCapture(a);
    await startCapture(b);
    await startCapture(c);

    await subscribeStatic(a, 'general');
    await subscribeFamily(b, 'rooms', 'room:1');

    await waitForFrame(a, (f) => f.event === '__subscribeOk__');
    await waitForFrame(b, (f) => f.event === '__subscribeOk__');

    await send(c, { event: 'observe-static', payload: { name: 'general' } });
    await waitForFrame(
      c,
      (f) =>
        f.event === 'observe-result' &&
        f.payload.where === 'static' &&
        f.payload.name === 'general',
    );
    const staticResult = (await frames(c)).find(
      (f) =>
        f.event === 'observe-result' &&
        f.payload.where === 'static' &&
        f.payload.name === 'general',
    )!;
    expect(staticResult.payload.count).toBe(1);

    await send(c, { event: 'observe-family', payload: { name: 'room:1' } });
    await waitForFrame(
      c,
      (f) =>
        f.event === 'observe-result' && f.payload.where === 'family' && f.payload.name === 'room:1',
    );
    const familyResult = (await frames(c)).find(
      (f) =>
        f.event === 'observe-result' && f.payload.where === 'family' && f.payload.name === 'room:1',
    )!;
    expect(familyResult.payload.count).toBe(1);

    await ctxA.close();
    await ctxB.close();
    await ctxC.close();
  });

  test('kick on static general kicks only the static member; family member with the same tag is untouched', async ({
    browser,
  }, testInfo) => {
    const room = `svfi-kick-static-${testInfo.testId}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const ctxC = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();
    const c = await ctxC.newPage();

    await setupClient(a, 'alice', room);
    await setupClient(b, 'bob', room);
    await setupClient(c, 'admin', room);
    await startCapture(a);
    await startCapture(b);
    await startCapture(c);

    // Both A and B carry the same self-applied tag 'troll'.
    await send(a, { event: 'tag-self', payload: { tag: 'troll' } });
    await send(b, { event: 'tag-self', payload: { tag: 'troll' } });
    await waitForFrame(a, (f) => f.event === 'tag-ack');
    await waitForFrame(b, (f) => f.event === 'tag-ack');

    await subscribeStatic(a, 'general');
    await subscribeFamily(b, 'rooms', 'room:1');
    await waitForFrame(a, (f) => f.event === '__subscribeOk__');
    await waitForFrame(b, (f) => f.event === '__subscribeOk__');

    // Kick on the static channel by the shared tag.
    await send(c, {
      event: 'kick-static',
      payload: { name: 'general', tag: 'troll', reason: 'banned' },
    });
    await waitForFrame(c, (f) => f.event === 'kick-ack' && f.payload.where === 'static');

    // A receives __kicked__ for general.
    await waitForFrame(a, (f) => f.event === '__kicked__' && f.__wskit?.channel === 'general');

    // Wait a beat to let any stray __kicked__ land for B.
    await b.waitForTimeout(300);
    const bFrames = await frames(b);
    expect(bFrames.some((f) => f.event === '__kicked__')).toBe(false);

    // B's connection is still alive: send-in-room round-trips a broadcast back.
    await send(b, {
      event: 'send-in-room',
      payload: { name: 'room:1', text: 'still-here' },
      __wskit: { channel: 'room:1', channelFamily: 'rooms' },
    });
    await waitForFrame(
      b,
      (f) => f.event === 'msg' && f.payload.from === 'family' && f.payload.text === 'still-here',
    );

    // Member counts settle: general 0, family 1.
    await send(c, { event: 'observe-static', payload: { name: 'general' } });
    await waitForFrame(c, (f) => f.event === 'observe-result' && f.payload.where === 'static');
    const staticAfter = (await frames(c))
      .filter((f) => f.event === 'observe-result' && f.payload.where === 'static')
      .pop()!;
    expect(staticAfter.payload.count).toBe(0);

    await send(c, { event: 'observe-family', payload: { name: 'room:1' } });
    await waitForFrame(c, (f) => f.event === 'observe-result' && f.payload.where === 'family');
    const familyAfter = (await frames(c))
      .filter((f) => f.event === 'observe-result' && f.payload.where === 'family')
      .pop()!;
    expect(familyAfter.payload.count).toBe(1);

    await ctxA.close();
    await ctxB.close();
    await ctxC.close();
  });

  test('kick on family rooms:room:1 kicks only the family member; static member with the same tag is untouched', async ({
    browser,
  }, testInfo) => {
    const room = `svfi-kick-family-${testInfo.testId}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const ctxC = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();
    const c = await ctxC.newPage();

    await setupClient(a, 'alice2', room);
    await setupClient(b, 'bob2', room);
    await setupClient(c, 'admin2', room);
    await startCapture(a);
    await startCapture(b);
    await startCapture(c);

    await send(a, { event: 'tag-self', payload: { tag: 'goblin' } });
    await send(b, { event: 'tag-self', payload: { tag: 'goblin' } });
    await waitForFrame(a, (f) => f.event === 'tag-ack');
    await waitForFrame(b, (f) => f.event === 'tag-ack');

    await subscribeStatic(a, 'general');
    await subscribeFamily(b, 'rooms', 'room:1');
    await waitForFrame(a, (f) => f.event === '__subscribeOk__');
    await waitForFrame(b, (f) => f.event === '__subscribeOk__');

    await send(c, {
      event: 'kick-family',
      payload: { name: 'room:1', tag: 'goblin', reason: 'banned' },
    });
    await waitForFrame(c, (f) => f.event === 'kick-ack' && f.payload.where === 'family');

    // B is kicked from family room:1.
    await waitForFrame(
      b,
      (f) =>
        f.event === '__kicked__' &&
        f.__wskit?.channel === 'room:1' &&
        f.__wskit?.channelFamily === 'rooms',
    );

    // A is untouched.
    await a.waitForTimeout(300);
    const aFrames = await frames(a);
    expect(aFrames.some((f) => f.event === '__kicked__')).toBe(false);

    // A is still alive: send-in-general round-trips.
    await send(a, {
      event: 'send-in-general',
      payload: { text: 'static-alive' },
      __wskit: { channel: 'general' },
    });
    await waitForFrame(
      a,
      (f) => f.event === 'msg' && f.payload.from === 'static' && f.payload.text === 'static-alive',
    );

    await ctxA.close();
    await ctxB.close();
    await ctxC.close();
  });
});
