import { handleReplay } from '~/replay/custom/custom.ts';
import type { PrimitiveKind, PrimitiveRef } from '~/primitive.ts';
import type {
  CustomReplayPrimitive,
  CustomReplaySendContext,
  OutgoingWireMessage,
} from '~/replay/custom/custom.ts';

const topLevelReplay = handleReplay({
  onBeforeSend(ctx, message) {
    const _ctx: CustomReplaySendContext = ctx;
    const _message: OutgoingWireMessage<'top'> = message;
    const _seq: number = message.wire.seq;
    const _messageId: string = message.wire.messageId;
    void [_ctx, _message, _seq, _messageId];

    // @ts-expect-error — top-level custom replay does not expose channel markers
    message.wire.channel;
  },
  onReplay(ctx, since) {
    const _since: number = since;
    void _since;
    ctx.sendReplay('message', { text: 'history' }, { seq: 1, messageId: 'm1' });
  },
});

const _topLevelReplayPrimitive: CustomReplayPrimitive = topLevelReplay;
const _topLevelTag: 'replayCustom' = topLevelReplay.__wskit;
const _topLevelKind: PrimitiveKind = topLevelReplay.__kind;
const _topLevelRef: PrimitiveRef = handleReplay;
void [_topLevelReplayPrimitive, _topLevelTag, _topLevelKind, _topLevelRef];

const channelReplay = handleReplay<'channel'>({
  onBeforeSend(ctx, message) {
    const _ctx: CustomReplaySendContext = ctx;
    const _message: OutgoingWireMessage<'channel'> = message;
    const _seq: number = message.wire.seq;
    const _messageId: string = message.wire.messageId;
    const _channel: string = message.wire.channel;
    // channelScope is `string | null` — `null` for static channels, family
    // key for dynamic families. Assigning a `string` is allowed; reading and
    // calling string methods without a null-guard is a type error.
    const _channelScope: string | null = message.wire.channelScope;
    // @ts-expect-error — channelScope may be null; .toUpperCase() needs a guard
    message.wire.channelScope.toUpperCase();
    if (message.wire.channelScope !== null) {
      const _afterGuard: string = message.wire.channelScope.toUpperCase();
      void _afterGuard;
    }
    void [_ctx, _message, _seq, _messageId, _channel, _channelScope];
  },
  onReplay(ctx, since) {
    const _channelName: string = ctx.channel.name;
    const _since: number = since;
    void [_channelName, _since];
    ctx.sendReplay('message', { text: 'history' }, { seq: 1, messageId: 'm1' });
  },
});

const _channelReplayPrimitive: CustomReplayPrimitive<'channel'> = channelReplay;
const _channelTag: 'replayCustom' = channelReplay.__wskit;
const _channelKind: PrimitiveKind = channelReplay.__kind;
const _channelRef: PrimitiveRef = handleReplay;
void [_channelReplayPrimitive, _channelTag, _channelKind, _channelRef];
