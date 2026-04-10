import { handleReplay } from '~/replay/custom.ts';
import type { PrimitiveKind, PrimitiveRef } from '~/primitive.ts';
import type { CustomReplayPrimitive, OutgoingWireMessage } from '~/replay/custom.ts';

const topLevelReplay = handleReplay({
  onBeforeSend(message) {
    const _message: OutgoingWireMessage<'top'> = message;
    const _seq: number = message.wire.seq;
    const _messageId: string = message.wire.messageId;
    void [_message, _seq, _messageId];

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
const _topLevelTag: 'customReplay' = topLevelReplay.__wskit;
const _topLevelKind: PrimitiveKind = topLevelReplay.__kind;
const _topLevelRef: PrimitiveRef = handleReplay;
void [_topLevelReplayPrimitive, _topLevelTag, _topLevelKind, _topLevelRef];

const channelReplay = handleReplay<'channel'>({
  onBeforeSend(message) {
    const _message: OutgoingWireMessage<'channel'> = message;
    const _seq: number = message.wire.seq;
    const _messageId: string = message.wire.messageId;
    const _channel: string = message.wire.channel;
    const _channelScope: string = message.wire.channelScope;
    void [_message, _seq, _messageId, _channel, _channelScope];
  },
  onReplay(ctx, since) {
    const _channelName: string = ctx.channel.name;
    const _since: number = since;
    void [_channelName, _since];
    ctx.sendReplay('message', { text: 'history' }, { seq: 1, messageId: 'm1' });
  },
});

const _channelReplayPrimitive: CustomReplayPrimitive<'channel'> = channelReplay;
const _channelTag: 'customReplay' = channelReplay.__wskit;
const _channelKind: PrimitiveKind = channelReplay.__kind;
const _channelRef: PrimitiveRef = handleReplay;
void [_channelReplayPrimitive, _channelTag, _channelKind, _channelRef];
