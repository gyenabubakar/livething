/* oxlint-disable @typescript-eslint/no-explicit-any */
import { channel, scope } from '~/channel/channel.ts';
import { incoming } from '~/incoming/incoming.ts';
import { outgoing } from '~/outgoing/outgoing.ts';
import { received } from '~/received.ts';
import { replay } from '~/replay/replay.ts';
import { request } from '~/request/request.ts';
import { chunks, generate, nudge, start, stream } from '~/stream/stream.ts';
import { t } from '~/t.ts';
import type {
  ChannelHandlerContext,
  ChannelPrimitive,
  ScopeDeclaration,
} from '~/channel/channel.ts';
import type { PrimitiveKind, PrimitiveRef } from '~/primitive.ts';

// ===========================================================================
// 1. static channel preserves string pattern
// ===========================================================================

const general = channel(
  'general',
  outgoing('message', t<{ text: string }>()),
  incoming(
    received('send-message', (value: unknown) => value as { text: string }),
    async (ctx, payload) => {
      const _name: string = ctx.channel.name;
      const _text: string = payload.text;
      void [_name, _text];

      ctx.send('message', { text: payload.text });

      // @ts-expect-error — top-level event not visible in channel scope
      ctx.send('alert', { level: 'info' });
    },
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
    received('start-typing'),
    async (ctx: ChannelHandlerContext<{ typing: { userId: string } }, false>) => {
      const _name: string = ctx.channel.name;
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
  incoming(received('ping'), async () => {}),
  request('status', async (ctx) => {
    const _name: string = ctx.channel.name;
    void _name;

    ctx.send('done', { ok: true });
    return { ok: true };
  }),
  generate(aiStream, async function* (ctx, payload) {
    const _name: string = ctx.channel.name;
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
// 4. channel() accepts replay() and types sendReplay()
// ===========================================================================

const replayRoom = channel(
  scope('replayRooms', /^replay-room-/),
  replay(),
  outgoing('message', t<{ text: string }>()),
  incoming(
    received('replay-message', (value: unknown) => value as { text: string }),
    async (ctx, payload) => {
      const _name: string = ctx.channel.name;
      const _text: string = payload.text;
      void [_name, _text];

      ctx.sendReplay('message', { text: payload.text }, { seq: 1, messageId: 'm1' });

      // @ts-expect-error — only channel-local outgoing events are allowed
      ctx.sendReplay('typing', { userId: 'u1' }, { seq: 1, messageId: 'm1' });
    },
  ),
  request('replay-status', async (ctx) => {
    ctx.sendReplay('message', { text: 'history' }, { seq: 2, messageId: 'm2' });
    return { ok: true };
  }),
  generate(aiStream, async function* (ctx, payload) {
    ctx.sendReplay('message', { text: payload.prompt }, { seq: 3, messageId: 'm3' });
    yield { text: payload.prompt };
  }),
);

const _replayRoomType: ChannelPrimitive<ScopeDeclaration<'replayRooms'>> = replayRoom;
void _replayRoomType;

// ===========================================================================
// 5. channel and scope are usable from type positions
// ===========================================================================

const _channelRef: PrimitiveRef = channel;
const _channelKey: symbol = channel.__key;
void [_channelRef, _channelKey];
