/* oxlint-disable @typescript-eslint/no-explicit-any */
import { channel, scope } from '~/primitives/channel.ts';
import { incoming } from '~/primitives/incoming.ts';
import { outgoing } from '~/primitives/outgoing.ts';
import { request } from '~/primitives/request.ts';
import { chunks, generate, nudge, start, stream } from '~/primitives/stream.ts';
import { t } from '~/t.ts';
import type {
  ChannelHandlerContext,
  ChannelPrimitive,
  ScopeDeclaration,
} from '~/primitives/channel.ts';
import type { PrimitiveKind, PrimitiveRef } from '~/primitives/define.ts';

// ===========================================================================
// 1. static channel preserves string pattern
// ===========================================================================

const general = channel(
  'general',
  outgoing('message', t<{ text: string }>()),
  incoming(
    'send-message',
    async (ctx, payload) => {
      const _name: string = ctx.channelName;
      const _text: string = payload.text;
      void [_name, _text];

      ctx.send('message', { text: payload.text });

      // @ts-expect-error — top-level event not visible in channel scope
      ctx.send('alert', { level: 'info' });
    },
    { validator: (value: unknown) => value as { text: string } },
  ),
);

const _pattern: 'general' = general.pattern;
const _tag: 'channel' = general.__wskit;
const _kind: PrimitiveKind = general.__kind;
const _channelType: ChannelPrimitive<'general'> = general;
void [_pattern, _tag, _kind, _channelType];

// ===========================================================================
// 2. dynamic channel families use scope()
// ===========================================================================

const rooms = scope('rooms', /^room-/);
const _scopeType: ScopeDeclaration<'rooms'> = rooms;
void _scopeType;

const roomChannel = channel(
  rooms,
  outgoing('typing', t<{ userId: string }>()),
  incoming(
    'start-typing',
    async (ctx: ChannelHandlerContext<{ typing: { userId: string } }, false>) => {
      const _name: string = ctx.channelName;
      void _name;

      ctx.send('typing', { userId: 'u1' });

      // @ts-expect-error — ack only exists when top-level ack() types the channel
      ctx.ack();
    },
  ),
);

const _dynamicChannelType: ChannelPrimitive<typeof rooms> = roomChannel;
void _dynamicChannelType;

// ===========================================================================
// 3. channel() types request() and generate()
// ===========================================================================

const aiStream = stream(
  start('ask-ai', (value: unknown) => value as { prompt: string }),
  chunks(t<{ text: string }>()),
  nudge('cancel'),
);

const aiRoom = channel(
  scope('aiRooms', /^ai-room-/),
  outgoing('chunk', t<{ text: string }>()),
  outgoing('done', t<{ ok: true }>()),
  incoming('ping', async () => {}),
  request('status', async (ctx) => {
    const _name: string = ctx.channelName;
    void _name;

    ctx.send('done', { ok: true });
    return { ok: true };
  }),
  generate(aiStream, async function* (ctx, payload) {
    const _name: string = ctx.channelName;
    void _name;

    ctx.send('chunk', { text: payload.prompt });

    const nudges = ctx.nudges(yield { text: payload.prompt });
    const _event: 'cancel' = nudges[0]!.event;
    void _event;
  }),
);

const _aiRoomType: ChannelPrimitive<ScopeDeclaration<'aiRooms'>> = aiRoom;
void _aiRoomType;

// ===========================================================================
// 4. channel and scope are usable from type positions
// ===========================================================================

const _channelRef: PrimitiveRef = channel;
const _channelKey: symbol = channel.__key;
void [_channelRef, _channelKey];
