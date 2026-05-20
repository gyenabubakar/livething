import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { connect, frames, installRig, send, waitForFrame } from './_ws-rig.ts';

async function openRig(page: Page, route: string) {
  await page.goto(route);
  await installRig(page);
}

test.describe('surface-area gaps', () => {
  test('request() inside a namespace returns the namespace-scoped response', async ({
    page,
  }, testInfo) => {
    const room = `sag-${testInfo.testId}`;
    await openRig(page, '/namespace');
    const a = await connect(page, '/ws/namespace', 'alice', room);

    await send(page, a, {
      event: 'get-ns-info',
      payload: { _namespace: 'ns', _correlationId: 'corr-1' },
    });

    const reply = await waitForFrame(
      page,
      a,
      (f) => f.event === 'get-ns-info' && f.payload._correlationId === 'corr-1',
    );
    expect(reply.payload._namespace).toBe('ns');
    expect(reply.payload.namespace).toBe('ns');
  });

  // namespace('x', ns => ns.channel('y', ...)) compiles at the API level
  // (NamespaceDef accepts ChannelDef in its definitions; NamespaceImplement
  // exposes .channel(...)) but the compile step does not preserve nested
  // channels inside CompiledNamespace, and scope resolution rejects frames
  // that carry both _namespace and _channel as InvalidScopeMarkers. End-to-end
  // support is a real feature gap, not a small inline fix. Un-skip when nested
  // channels are wired through the compile + wire-routing paths.
  test.skip('channel nested inside a namespace — subscribe + incoming + scoped send round-trip', async () => {});

  test('rateLimit cascade — contract → namespace → channel → per-handler override all observable in one contract', async ({
    page,
  }, testInfo) => {
    const room = `sag-${testInfo.testId}`;
    await page.goto('/rate-limit');
    await installRig(page);
    const a = await connect(page, '/ws/rate-limit', 'alice', room);

    // Layer 1 — contract cap (top-level max=3). Fourth 'tick' rejected.
    for (let i = 0; i < 3; i += 1) {
      await send(page, a, { event: 'tick', payload: {} });
    }
    await page.waitForFunction(
      ([sid]) =>
        (window.__wskitFrames!(sid as string) ?? []).filter((f) => f.event === 'tock').length >= 3,
      [a],
    );
    await send(page, a, { event: 'tick', payload: {} });
    await page.waitForTimeout(150);
    const topErrors = (await frames(page, a)).filter(
      (f) => f.event === '_error' && f.payload.code === 'rate-limited',
    );
    expect(topErrors.length).toBeGreaterThanOrEqual(1);

    // Layer 2 — namespace cap (strict namespace max=2, tighter than contract).
    // The namespace bucket is independent of the top-level bucket.
    for (let i = 0; i < 2; i += 1) {
      await send(page, a, { event: 'strict-ping', payload: { _namespace: 'strict' } });
    }
    await page.waitForFunction(
      ([sid]) =>
        (window.__wskitFrames!(sid as string) ?? []).filter(
          (f) => f.event === 'strict-pong' && f.payload._namespace === 'strict',
        ).length >= 2,
      [a],
    );
    await send(page, a, { event: 'strict-ping', payload: { _namespace: 'strict' } });
    await page.waitForTimeout(150);
    const allErrors = (await frames(page, a)).filter(
      (f) => f.event === '_error' && f.payload.code === 'rate-limited',
    );
    expect(allErrors.length).toBeGreaterThanOrEqual(2);

    // Layer 3 — channel cap (rooms channel max=50, looser than contract).
    // No errors when sending one chatter — it would have been rate-limited at
    // the contract level had the channel not raised the cap. But the channel
    // also has a per-handler override on 'chatter' (max=1), so a second
    // 'chatter' is rejected at layer 4.
    await send(page, a, {
      event: '_subscribe',
      payload: { _channel: 'rooms' },
    });
    await waitForFrame(page, a, (f) => f.event === '_subscribeOk');
    await send(page, a, {
      event: 'chatter',
      payload: { _channel: 'rooms', text: 'hi' },
    });
    await page.waitForFunction(
      ([sid]) =>
        (window.__wskitFrames!(sid as string) ?? []).filter(
          (f) => f.event === 'chatter-broadcast' && f.payload._channel === 'rooms',
        ).length >= 1,
      [a],
    );

    // Layer 4 — per-handler override (chatter max=1) — second chatter rejected.
    await send(page, a, {
      event: 'chatter',
      payload: { _channel: 'rooms', text: 'hi2' },
    });
    await page.waitForTimeout(150);
    const chatErrors = (await frames(page, a)).filter(
      (f) => f.event === '_error' && f.payload.code === 'rate-limited',
    );
    expect(chatErrors.length).toBeGreaterThanOrEqual(3);
  });

  test('customReplay on a channel that has a stream — stream chunks never enter the replay log', async ({
    page,
  }, testInfo) => {
    const room = `sag-${testInfo.testId}`;
    await page.goto('/replay-custom');
    await installRig(page);
    const a = await connect(page, '/ws/replay-custom', 'alice', room);

    await send(page, a, { event: '_subscribe', payload: { _channel: 'custom-room' } });
    await waitForFrame(page, a, (f) => f.event === '_subscribeOk');

    // Trigger one logged outgoing (room-note via add-room-note) so the
    // replay log has at least one row to look at.
    await send(page, a, {
      event: 'add-room-note',
      payload: { _channel: 'custom-room', text: 'before-stream' },
    });
    await waitForFrame(
      page,
      a,
      (f) => f.event === 'room-note' && f.payload._channel === 'custom-room',
    );

    // Trigger the channel-scoped stream — it emits chunks via the outgoing
    // pipeline but those chunks must NOT show up in the customReplay log
    // (replay is for `outgoing(...)` only).
    await send(page, a, {
      event: 'room-stream',
      payload: { _channel: 'custom-room', count: 3 },
    });
    await waitForFrame(page, a, (f) => f.event === '_streamEnd');

    await send(page, a, {
      event: 'query-room-replay-events',
      payload: { _channel: 'custom-room' },
    });
    const logged = await waitForFrame(
      page,
      a,
      (f) => f.event === 'room-replay-events' && f.payload._channel === 'custom-room',
    );
    const events = logged.payload.events as string[];
    expect(events).toContain('room-note');
    expect(events).not.toContain('room-stream');
  });

  // `intercept('streamEvent', ...)` on a sub-builder works at runtime, but
  // the .intercept() type narrows E to keyof FieldOf<NsC, 'incoming'> in
  // server/src/_api/implement.ts and the channel/namespace builders. Adding
  // streams/requests/resumableStreams/recordedStreams to that constraint
  // (and resolving the payload type lookup across categories) is a real
  // type-system change, not a small inline fix. Un-skip when that lands.
  test.skip('intercept on a sub-builder rewrites the payload of a stream trigger', async () => {});
});
