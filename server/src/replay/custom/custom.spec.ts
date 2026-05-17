import { server } from '~/_builder/server-builder.ts';
import { ENGINE_INTERNAL_CONNECTION, ENGINE_SCOPE_META } from '~/_engine/contexts/types.ts';
import { Engine } from '~/_engine/engine.ts';
import { createChannelMembershipKey } from '~/channel/runtime.ts';
import { withDedup } from '~/dedup/with.ts';
import { event } from '~/event.ts';
import { handleReplay } from '~/replay/custom/custom.ts';
import { withReplayCustom } from '~/replay/custom/with.ts';
import { withSequence } from '~/sequence/with.ts';
import { describe, expect, it, vi } from 'vitest';
import type { EngineAccess } from '~/_engine/access.ts';
import type { IncomingProtocolEvent, WireOutgoingMessage } from '~/_engine/runtime/types.ts';

describe('custom replay', () => {
  it('clones top-level before-send messages and strips channel-only fields from the type surface', () => {
    const beforeSendHandlers: Array<NonNullable<Parameters<EngineAccess['onBeforeSend']>[0]>> = [];
    const seen: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const initHandlers: Array<(ctx: unknown) => void> = [];
    const engine = {
      getScopeInfo() {
        return {};
      },
      getReplayClaimedChannelKeys() {
        return new Set();
      },
      onInit(handler) {
        initHandlers.push(handler as (ctx: unknown) => void);
      },
      onBeforeSend(handler) {
        beforeSendHandlers.push(handler);
      },
      onProtocolMessage() {},
    } as Pick<
      EngineAccess,
      | 'getScopeInfo'
      | 'getReplayClaimedChannelKeys'
      | 'onInit'
      | 'onBeforeSend'
      | 'onProtocolMessage'
    > as EngineAccess;

    handleReplay({
      onBeforeSend(ctx, message) {
        seen.push({
          event: message.event,
          payload: {
            ...message.payload,
            _seq: message.wire.seq,
            _messageId: message.wire.messageId,
          },
        });
        (message.payload as Record<string, unknown>).text = 'changed';
        // Verify ctx provides storage access
        expect(ctx.sql).toBeDefined();
      },
      onReplay() {},
    }).__setup?.(engine);

    // Simulate onInit to capture send context
    for (const handler of initHandlers) {
      handler({ sql: {}, kv: {}, env: {}, log: {}, platform: {} });
    }

    const wireMessage: WireOutgoingMessage = {
      connectionId: 'c1',
      event: 'message',
      payload: {
        text: 'hello',
        _seq: 1,
        _messageId: 'm1',
      },
      meta: { username: 'test' },
    };

    beforeSendHandlers[0]!(wireMessage);

    expect(seen).toEqual([
      {
        event: 'message',
        payload: {
          text: 'hello',
          _seq: 1,
          _messageId: 'm1',
        },
      },
    ]);
    expect(wireMessage.payload.text).toBe('hello');
  });

  it('top-level before-send wire carries channel and channelScope for cascaded channel messages', () => {
    const beforeSendHandlers: Array<NonNullable<Parameters<EngineAccess['onBeforeSend']>[0]>> = [];
    const seenWires: Array<{ channel: unknown; channelScope: unknown }> = [];
    const initHandlers: Array<(ctx: unknown) => void> = [];
    const engine = {
      getScopeInfo() {
        return {};
      },
      getReplayClaimedChannelKeys() {
        return new Set();
      },
      onInit(handler) {
        initHandlers.push(handler as (ctx: unknown) => void);
      },
      onBeforeSend(handler) {
        beforeSendHandlers.push(handler);
      },
      onProtocolMessage() {},
    } as Pick<
      EngineAccess,
      | 'getScopeInfo'
      | 'getReplayClaimedChannelKeys'
      | 'onInit'
      | 'onBeforeSend'
      | 'onProtocolMessage'
    > as EngineAccess;

    handleReplay({
      onBeforeSend(_ctx, message) {
        seenWires.push({
          channel: message.wire.channel,
          channelScope: message.wire.channelScope,
        });
      },
      onReplay() {},
    }).__setup?.(engine);

    for (const handler of initHandlers) {
      handler({ sql: {}, kv: {}, env: {}, log: {}, platform: {} });
    }

    // Top-level message — neither channel nor channelScope on the payload.
    beforeSendHandlers[0]!({
      connectionId: 'c1',
      event: 'message',
      payload: { text: 'top', _seq: 1, _messageId: 'm1' },
      meta: {},
    });
    // Cascaded static-channel message — channel set, channelScope absent.
    beforeSendHandlers[0]!({
      connectionId: 'c1',
      event: 'message',
      payload: { text: 'static', _seq: 2, _messageId: 'm2', _channel: 'lobby' },
      meta: {},
    });
    // Cascaded family-channel message — both channel and channelScope set.
    beforeSendHandlers[0]!({
      connectionId: 'c1',
      event: 'message',
      payload: {
        text: 'family',
        _seq: 3,
        _messageId: 'm3',
        _channel: 'room:1',
        _channelScope: 'rooms',
      },
      meta: {},
    });

    expect(seenWires).toEqual([
      { channel: null, channelScope: null },
      { channel: 'lobby', channelScope: null },
      { channel: 'room:1', channelScope: 'rooms' },
    ]);
  });

  it('only observes channel messages for the matching channel scope', async () => {
    const beforeSendHandlers: Array<NonNullable<Parameters<EngineAccess['onBeforeSend']>[0]>> = [];
    const protocolHandlers: Array<NonNullable<Parameters<EngineAccess['onProtocolMessage']>[1]>> =
      [];
    const seen: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const replayCalls: Array<{
      since: number;
      channel: string;
    }> = [];
    const sent: Array<Parameters<EngineAccess['sendReplay']>> = [];
    const initHandlers2: Array<(ctx: unknown) => void> = [];
    const engine = {
      getScopeInfo() {
        return { channelKey: 'rooms' };
      },
      getReplayClaimedChannelKeys() {
        return new Set();
      },
      onInit(handler) {
        initHandlers2.push(handler as (ctx: unknown) => void);
      },
      onBeforeSend(handler) {
        beforeSendHandlers.push(handler);
      },
      onProtocolMessage(
        event: IncomingProtocolEvent,
        handler: NonNullable<Parameters<EngineAccess['onProtocolMessage']>[1]>,
      ) {
        if (event === '_replay') protocolHandlers.push(handler);
      },
      sendReplay(...args: Parameters<EngineAccess['sendReplay']>) {
        sent.push(args);
      },
      assertReplaySendContract() {},
    } as Pick<
      EngineAccess,
      | 'getScopeInfo'
      | 'getReplayClaimedChannelKeys'
      | 'onInit'
      | 'onBeforeSend'
      | 'onProtocolMessage'
      | 'sendReplay'
      | 'assertReplaySendContract'
    > as EngineAccess;

    handleReplay<'channel'>({
      onBeforeSend(_ctx, message) {
        seen.push({
          event: message.event,
          payload: {
            ...message.payload,
            _seq: message.wire.seq,
            _messageId: message.wire.messageId,
            _channel: message.wire.channel,
            _channelScope: message.wire.channelScope,
          },
        });
      },
      onReplay(ctx, since) {
        replayCalls.push({
          since,
          channel: ctx.channel.name,
        });
        ctx.sendReplay('message', { text: 'history' }, { seq: 5, messageId: 'm5' });
      },
    }).__setup?.(engine);

    // Simulate onInit to capture send context
    for (const handler of initHandlers2) {
      handler({ sql: {}, kv: {}, env: {}, log: {}, platform: {} });
    }

    beforeSendHandlers[0]!({
      connectionId: 'c1',
      event: 'message',
      payload: {
        text: 'rooms',
        _seq: 1,
        _messageId: 'm1',
        _channel: 'room-1',
        _channelScope: 'rooms',
      },
      meta: {},
    });
    beforeSendHandlers[0]!({
      connectionId: 'c1',
      event: 'message',
      payload: {
        text: 'other',
        _seq: 2,
        _messageId: 'm2',
        _channel: 'room-2',
        _channelScope: 'other',
      },
      meta: {},
    });

    expect(seen).toEqual([
      {
        event: 'message',
        payload: {
          text: 'rooms',
          _seq: 1,
          _messageId: 'm1',
          _channel: 'room-1',
          _channelScope: 'rooms',
        },
      },
    ]);

    await protocolHandlers[0]!(
      {
        id: 'c1',
        sql: {},
        kv: {},
        env: {},
        log: {},
        platform: {},
        waitUntil() {},
        [ENGINE_SCOPE_META]: {
          channelName: 'room-1',
          channelScope: 'rooms',
        },
        [ENGINE_INTERNAL_CONNECTION]: {
          channelMemberships: new Map([
            [
              createChannelMembershipKey('room-1', 'rooms'),
              { channelName: 'room-1', channelScope: 'rooms' },
            ],
          ]),
        },
      },
      { since: 4, _channel: 'room-1', _channelScope: 'rooms' },
    );

    expect(replayCalls).toEqual([{ since: 4, channel: 'room-1' }]);
    expect(sent).toEqual([
      ['c1', 'room-1', 'rooms', 'message', { text: 'history' }, { seq: 5, messageId: 'm5' }],
    ]);
  });

  it('silently denies channel replay for a non-member', async () => {
    const protocolHandlers: Array<NonNullable<Parameters<EngineAccess['onProtocolMessage']>[1]>> =
      [];
    const replayCalls: Array<unknown> = [];
    const sent: Array<Parameters<EngineAccess['sendReplay']>> = [];
    const engine = {
      getScopeInfo() {
        return { channelKey: 'rooms' };
      },
      getReplayClaimedChannelKeys() {
        return new Set();
      },
      onInit() {},
      onBeforeSend() {},
      onProtocolMessage(
        event: IncomingProtocolEvent,
        handler: NonNullable<Parameters<EngineAccess['onProtocolMessage']>[1]>,
      ) {
        if (event === '_replay') protocolHandlers.push(handler);
      },
      sendReplay(...args: Parameters<EngineAccess['sendReplay']>) {
        sent.push(args);
      },
      assertReplaySendContract() {},
    } as Pick<
      EngineAccess,
      | 'getScopeInfo'
      | 'getReplayClaimedChannelKeys'
      | 'onInit'
      | 'onBeforeSend'
      | 'onProtocolMessage'
      | 'sendReplay'
      | 'assertReplaySendContract'
    > as EngineAccess;

    handleReplay<'channel'>({
      onReplay() {
        replayCalls.push('called');
      },
    }).__setup?.(engine);

    const result = await protocolHandlers[0]!(
      {
        id: 'non-member',
        sql: {},
        kv: {},
        env: {},
        log: {},
        platform: {},
        waitUntil() {},
        [ENGINE_SCOPE_META]: {
          channelName: 'room-private',
          channelScope: 'rooms',
        },
        [ENGINE_INTERNAL_CONNECTION]: {
          channelMemberships: new Map(),
        },
      },
      { since: 0, _channel: 'room-private', _channelScope: 'rooms' },
    );

    expect(result).toBe(true);
    expect(replayCalls).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('top-level custom replay rejects channel-scoped _replay from a non-member without invoking onReplay', async () => {
    const protocolHandlers: Array<NonNullable<Parameters<EngineAccess['onProtocolMessage']>[1]>> =
      [];
    const replayCalls: Array<unknown> = [];
    const sent: Array<Parameters<EngineAccess['sendReplay']>> = [];
    const engine = {
      // Top-level: NO channelKey.
      getScopeInfo() {
        return {};
      },
      getReplayClaimedChannelKeys() {
        return new Set();
      },
      onInit() {},
      onBeforeSend() {},
      onProtocolMessage(
        event: IncomingProtocolEvent,
        handler: NonNullable<Parameters<EngineAccess['onProtocolMessage']>[1]>,
      ) {
        if (event === '_replay') protocolHandlers.push(handler);
      },
      sendReplay(...args: Parameters<EngineAccess['sendReplay']>) {
        sent.push(args);
      },
      assertReplaySendContract() {},
    } as Pick<
      EngineAccess,
      | 'getScopeInfo'
      | 'getReplayClaimedChannelKeys'
      | 'onInit'
      | 'onBeforeSend'
      | 'onProtocolMessage'
      | 'sendReplay'
      | 'assertReplaySendContract'
    > as EngineAccess;

    handleReplay({
      onReplay() {
        replayCalls.push('called');
      },
    }).__setup?.(engine);

    const result = await protocolHandlers[0]!(
      {
        id: 'snooper',
        sql: {},
        kv: {},
        env: {},
        log: {},
        platform: {},
        waitUntil() {},
        [ENGINE_SCOPE_META]: {
          // Top-level _replay request that nonetheless carries a channel
          // scope on the payload — without the membership check the
          // top-level handler would happily run onReplay.
          channelName: 'private-room',
          channelScope: 'rooms',
        },
        [ENGINE_INTERNAL_CONNECTION]: {
          channelMemberships: new Map(),
        },
      },
      { since: 0, _channel: 'private-room', _channelScope: 'rooms' },
    );

    // Silent ack — no rows leaked, onReplay never ran.
    expect(result).toBe(true);
    expect(replayCalls).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('builds a channel-shaped context for static channel replay (no _channelScope on payload)', async () => {
    const protocolHandlers: Array<NonNullable<Parameters<EngineAccess['onProtocolMessage']>[1]>> =
      [];
    const seenContexts: Array<{ id: string; channelName: string }> = [];
    const engine = {
      getScopeInfo() {
        return { channelKey: 'replay-room' };
      },
      getReplayClaimedChannelKeys() {
        return new Set();
      },
      onInit() {},
      onBeforeSend() {},
      onProtocolMessage(
        event: IncomingProtocolEvent,
        handler: NonNullable<Parameters<EngineAccess['onProtocolMessage']>[1]>,
      ) {
        if (event === '_replay') protocolHandlers.push(handler);
      },
      sendReplay() {},
      assertReplaySendContract() {},
    } as Pick<
      EngineAccess,
      | 'getScopeInfo'
      | 'getReplayClaimedChannelKeys'
      | 'onInit'
      | 'onBeforeSend'
      | 'onProtocolMessage'
      | 'sendReplay'
      | 'assertReplaySendContract'
    > as EngineAccess;

    handleReplay<'channel'>({
      onReplay(ctx) {
        seenContexts.push({ id: ctx.id, channelName: ctx.channel.name });
      },
    }).__setup?.(engine);

    const result = await protocolHandlers[0]!(
      {
        id: 'c-static',
        sql: {},
        kv: {},
        env: {},
        log: {},
        platform: {},
        waitUntil() {},
        [ENGINE_SCOPE_META]: {
          channelName: 'replay-room',
          // Note: no channelScope — this is a static channel.
        },
        [ENGINE_INTERNAL_CONNECTION]: {
          channelMemberships: new Map([
            [
              createChannelMembershipKey('replay-room', null),
              { channelName: 'replay-room', channelScope: null },
            ],
          ]),
        },
      },
      { since: 0 },
    );

    expect(result).toBe(true);
    expect(seenContexts).toEqual([{ id: 'c-static', channelName: 'replay-room' }]);
  });

  it('ctx.sendReplay() in onReplay does not re-trigger onBeforeSend', async () => {
    const beforeSendCalls: string[] = [];
    const replaySent: Parameters<EngineAccess['sendReplay']>[] = [];
    const initHandlers: Array<(ctx: unknown) => void> = [];
    const protocolHandlers: Array<NonNullable<Parameters<EngineAccess['onProtocolMessage']>[1]>> =
      [];

    const engine = {
      getScopeInfo() {
        return {};
      },
      getReplayClaimedChannelKeys() {
        return new Set();
      },
      onInit(handler: (ctx: unknown) => void | Promise<void>) {
        initHandlers.push(handler as (ctx: unknown) => void);
      },
      onBeforeSend(handler: Parameters<EngineAccess['onBeforeSend']>[0]) {
        beforeSendCalls; // captured via closure below
        // Register a spy that records call events.
        handler as unknown as (msg: unknown) => void;
        // We'll record any calls via the spy below.
        const spy = vi.fn((msg: { event: string }) => {
          beforeSendCalls.push(msg.event);
        });
        (engine as unknown as { __spy: typeof spy }).__spy = spy;
        // Wrap: call our spy then the real handler.
        (engine as unknown as { __handler: typeof handler }).__handler = handler;
      },
      onProtocolMessage(
        event: string,
        handler: NonNullable<Parameters<EngineAccess['onProtocolMessage']>[1]>,
      ) {
        if (event === '_replay') protocolHandlers.push(handler);
      },
      sendReplay(...args: Parameters<EngineAccess['sendReplay']>) {
        replaySent.push(args);
      },
      assertReplaySendContract() {},
    } as unknown as EngineAccess;

    handleReplay({
      onBeforeSend(_ctx, message) {
        beforeSendCalls.push(message.event);
      },
      onReplay(ctx, _since) {
        ctx.sendReplay('message', { text: 'replayed' }, { seq: 1, messageId: 'm1' });
      },
    }).__setup?.(engine);

    for (const handler of initHandlers) {
      handler({ sql: {}, kv: {}, env: {}, log: {}, platform: {} });
    }

    // Capture how many onBeforeSend calls happen before onReplay runs.
    const countBefore = beforeSendCalls.length;

    await protocolHandlers[0]!(
      {
        id: 'c1',
        sql: {},
        kv: {},
        env: {},
        log: {},
        platform: {},
        waitUntil() {},
        [ENGINE_SCOPE_META]: {},
      },
      { since: 0 },
    );

    // sendReplay was called inside onReplay.
    expect(replaySent).toHaveLength(1);
    expect(replaySent[0]![3]).toBe('message');

    // onBeforeSend must NOT have fired again for the replayed message.
    expect(beforeSendCalls.length).toBe(countBefore);
  });

  it('top-level onReplay forwards wire.channelScope into engine.sendReplay so family routing survives', async () => {
    const protocolHandlers: Array<NonNullable<Parameters<EngineAccess['onProtocolMessage']>[1]>> =
      [];
    const sent: Array<Parameters<EngineAccess['sendReplay']>> = [];
    const engine = {
      // Top-level replayCustom — no channelKey.
      getScopeInfo() {
        return {};
      },
      getReplayClaimedChannelKeys() {
        return new Set();
      },
      onInit() {},
      onBeforeSend() {},
      onProtocolMessage(
        event: IncomingProtocolEvent,
        handler: NonNullable<Parameters<EngineAccess['onProtocolMessage']>[1]>,
      ) {
        if (event === '_replay') protocolHandlers.push(handler);
      },
      sendReplay(...args: Parameters<EngineAccess['sendReplay']>) {
        sent.push(args);
      },
      assertReplaySendContract() {},
    } as Pick<
      EngineAccess,
      | 'getScopeInfo'
      | 'getReplayClaimedChannelKeys'
      | 'onInit'
      | 'onBeforeSend'
      | 'onProtocolMessage'
      | 'sendReplay'
      | 'assertReplaySendContract'
    > as EngineAccess;

    handleReplay({
      onReplay(ctx) {
        // Dev persisted channelScope='rooms' alongside the row and now
        // restores it on replay. The engine must forward it.
        ctx.sendReplay(
          'message',
          { text: 'history' },
          { seq: 7, messageId: 'm7', channel: 'room-1', channelScope: 'rooms' },
        );
      },
    }).__setup?.(engine);

    // Owner is a member of room-1 in the rooms family.
    const member = {
      id: 'owner',
      sql: {},
      kv: {},
      env: {},
      log: {},
      platform: {},
      waitUntil() {},
      [ENGINE_SCOPE_META]: {},
      [ENGINE_INTERNAL_CONNECTION]: {
        channelMemberships: new Map([
          [JSON.stringify(['rooms', 'room-1']), { channelName: 'room-1', channelScope: 'rooms' }],
        ]),
      },
    };
    await protocolHandlers[0]!(member, { since: 0, _channel: 'room-1', _channelScope: 'rooms' });

    expect(sent).toHaveLength(1);
    const [connectionId, channelName, channelScope] = sent[0]!;
    expect(connectionId).toBe('owner');
    expect(channelName).toBe('room-1');
    expect(channelScope).toBe('rooms');
  });

  it('strict-durability: onBeforeSend fires before descriptor.send', async () => {
    const calls: string[] = [];
    const onBeforeSendSpy = vi.fn(() => {
      calls.push('onBeforeSend');
    });

    const msg = event('msg', (p: unknown) => p as { text: string });
    const sendMsg = event('send-msg', (p: unknown) => p as { text: string });

    const def = withReplayCustom(withDedup(withSequence(server('chat'))))
      .sequence({ persist: true })
      .dedup()
      .replayCustom((r) => r.onBeforeSend(onBeforeSendSpy).onReplay(async (_ctx, _since) => {}))
      .outgoing(msg)
      .incoming(sendMsg, async (ctx, payload) => {
        ctx.send('msg', { text: payload.text });
      })
      .build();

    function fakeSqlResult(rows: Record<string, unknown>[] = []) {
      return {
        toArray: () => [...rows],
        one: () => rows[0] ?? null,
        raw: () => rows.map((r) => Object.values(r)),
      };
    }
    const sql = {
      exec: () => fakeSqlResult([]),
      transaction<T>(fn: (tx: unknown) => T) {
        return fn({ exec: () => fakeSqlResult([]) });
      },
    };
    const storage = {
      sql,
      kv: {
        get: vi.fn(async () => undefined),
        set: vi.fn(async () => {}),
        delete: vi.fn(async () => {}),
        list: vi.fn(async () => []),
      },
    };
    const timers = {
      setTimeout: (fn: () => void) => fn,
      clearTimeout: () => {},
    };

    const engine = new Engine(def, { adapterId: 'strict-custom' });
    engine.setStorage(storage as never);
    engine.setTimerProvider(timers as never);
    engine.setWaitUntil(() => {});

    await engine.initialize();

    const sendSpy = vi.fn((_data) => {
      calls.push('send');
    });
    const handle = engine.accept(Symbol('ws'), {
      send: sendSpy,
      sendBinary() {},
      close() {},
      bufferedAmount() {
        return 0;
      },
      identity: 'replay-custom-test',
    });

    await handle.handleMessage(JSON.stringify({ event: 'send-msg', payload: { text: 'hi' } }));

    expect(onBeforeSendSpy).toHaveBeenCalled();
    expect(sendSpy).toHaveBeenCalled();
    expect(calls).toEqual(['onBeforeSend', 'send']);
  });
});
