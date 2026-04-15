import { ENGINE_SCOPE_META } from '~/_engine/contexts/types.ts';
import { handleReplay } from '~/replay/custom/custom.ts';
import { describe, expect, it } from 'vitest';
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
      onInit(handler) {
        initHandlers.push(handler as (ctx: unknown) => void);
      },
      onBeforeSend(handler) {
        beforeSendHandlers.push(handler);
      },
      onProtocolMessage() {},
    } as Pick<
      EngineAccess,
      'getScopeInfo' | 'onInit' | 'onBeforeSend' | 'onProtocolMessage'
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
    } as Pick<
      EngineAccess,
      'getScopeInfo' | 'onInit' | 'onBeforeSend' | 'onProtocolMessage' | 'sendReplay'
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
      },
      { since: 4 },
    );

    expect(replayCalls).toEqual([{ since: 4, channel: 'room-1' }]);
    expect(sent).toEqual([
      ['c1', 'room-1', 'rooms', 'message', { text: 'history' }, { seq: 5, messageId: 'm5' }],
    ]);
  });
});
