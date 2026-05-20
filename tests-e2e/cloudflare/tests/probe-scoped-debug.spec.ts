import { expect, test } from '@playwright/test';
import { closeSocket, connect, frames, installRig, send } from './_ws-rig.ts';

test('debug-scoped', async ({ page }, testInfo) => {
  await page.goto('/stream-durable-scoped');
  await installRig(page);
  const room = `dbg-${testInfo.testId}`;
  const a = await connect(page, '/ws/stream-durable-scoped', 'alice', room);
  await send(page, a, { event: '_subscribe', payload: { _channel: 'rooms' } });
  await page.waitForTimeout(300);
  await send(page, a, { event: 'paginate', payload: { _channel: 'rooms', _streamId: 'p-1' } });
  await page.waitForFunction(
    ([sid]) =>
      (window.__wskitFrames!(sid as string) ?? []).filter((f) => f.event === 'paginate').length >=
      2,
    [a],
  );
  await closeSocket(page, a);
  await page.waitForTimeout(150);
  const b = await connect(page, '/ws/stream-durable-scoped', 'alice', room);
  await send(page, b, {
    event: '_resumeStream',
    payload: { _channel: 'rooms', _streamId: 'p-1', since: 0 },
  });
  await page.waitForTimeout(3000);
  console.log('B frames:', JSON.stringify(await frames(page, b), null, 2));
  expect(true).toBe(true);
});
