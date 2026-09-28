import { handleReplay } from '~/replay/custom/custom.ts';
import type { PrimitiveKind, PrimitiveRef } from '~/primitive.ts';
import type {
  CustomReplayPrimitive,
  CustomReplaySendContext,
  OutgoingWireMessage,
} from '~/replay/custom/custom.ts';

const topLevelReplay = handleReplay({
  onBeforeBroadcast(ctx, message) {
    const _ctx: CustomReplaySendContext = ctx;
    const _message: OutgoingWireMessage<'top'> = message;
    const _seq: number = message.wire.deliverySeq;
    const _messageId: string = message.wire.messageId;
    // Top-level custom replay observes channel-scoped messages too via the
    // cascade. `channel` is null for true top-level messages, the concrete
    // name when the message originated in a channel. `channelFamily` is the
    // family key for dynamic families and null for static channels.
    const _channel: string | null = message.wire.channel;
    const _channelFamily: string | null = message.wire.channelFamily;
    // @ts-expect-error — channel may be null; calling string methods needs a guard
    message.wire.channel.toUpperCase();
    if (message.wire.channel !== null) {
      const _afterGuard: string = message.wire.channel.toUpperCase();
      void _afterGuard;
    }

    // A broadcast to everyone in its scope has no user; one sent to a single user names it.
    const _userId: string | null = message.userId;
    // @ts-expect-error — userId may be null; calling string methods needs a guard
    message.userId.toUpperCase();
    // @ts-expect-error — a broadcast has no single connection, so there is no per-connection meta
    ctx.meta;

    void [_ctx, _message, _seq, _messageId, _channel, _channelFamily, _userId];
  },
  onReplay(ctx, since) {
    const _since: number = since;
    const _requester: string | null = ctx.userId;
    void [_since, _requester];
    ctx.sendReplay('message', { text: 'history' }, { deliverySeq: 1, messageId: 'm1' });
  },
});

const _topLevelReplayPrimitive: CustomReplayPrimitive = topLevelReplay;
const _topLevelTag: 'replayCustom' = topLevelReplay.__livething;
const _topLevelKind: PrimitiveKind = topLevelReplay.__kind;
const _topLevelRef: PrimitiveRef = handleReplay;
void [_topLevelReplayPrimitive, _topLevelTag, _topLevelKind, _topLevelRef];

const channelReplay = handleReplay<'channel'>({
  onBeforeBroadcast(ctx, message) {
    const _ctx: CustomReplaySendContext = ctx;
    const _message: OutgoingWireMessage<'channel'> = message;
    const _seq: number = message.wire.deliverySeq;
    const _messageId: string = message.wire.messageId;
    const _channel: string = message.wire.channel;
    // channelFamily is `string | null` — `null` for static channels, family
    // key for dynamic families. Assigning a `string` is allowed; reading and
    // calling string methods without a null-guard is a type error.
    const _channelFamily: string | null = message.wire.channelFamily;
    // @ts-expect-error — channelFamily may be null; .toUpperCase() needs a guard
    message.wire.channelFamily.toUpperCase();
    if (message.wire.channelFamily !== null) {
      const _afterGuard: string = message.wire.channelFamily.toUpperCase();
      void _afterGuard;
    }

    void [_ctx, _message, _seq, _messageId, _channel, _channelFamily];
  },
  onReplay(ctx, since) {
    const _channelName: string = ctx.channel.name;
    const _since: number = since;
    const _requester: string | null = ctx.userId;
    void [_channelName, _since, _requester];
    ctx.sendReplay('message', { text: 'history' }, { deliverySeq: 1, messageId: 'm1' });
  },
});

const _channelReplayPrimitive: CustomReplayPrimitive<'channel'> = channelReplay;
const _channelTag: 'replayCustom' = channelReplay.__livething;
const _channelKind: PrimitiveKind = channelReplay.__kind;
const _channelRef: PrimitiveRef = handleReplay;
void [_channelReplayPrimitive, _channelTag, _channelKind, _channelRef];
