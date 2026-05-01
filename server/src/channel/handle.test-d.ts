/* oxlint-disable @typescript-eslint/no-explicit-any */

/**
 * Type-level tests for the unified ChannelHandle / ChannelsManager API.
 *
 * The test passes if the file compiles. `@ts-expect-error` markers assert
 * that the listed expression is rejected by the type checker.
 */

import { server } from '~/_builder/server-builder.ts';
import { scope } from '~/channel/channel.ts';
import { withChannels } from '~/channel/with.ts';
import { event } from '~/event.ts';
import { describe, it } from 'vitest';
import type { ConnectionInfo } from '~/context.ts';

const RoomMessage = event('room-message', (p: unknown) => p as { text: string });
const Send = event('send', (p: unknown) => p as { text: string });

describe('ChannelHandle type tests', () => {
  it('static channels: ctx.channels.get(name).members() typed; broadcast typed to declared events', () => {
    const base = withChannels(server('chat'));
    base.use(base.channel('lobby', (ch) => ch.outgoing(RoomMessage))).incoming(Send, (ctx) => {
      const members: ConnectionInfo[] = ctx.channels.get('lobby').members();
      void members;

      ctx.channels.get('lobby').broadcast('room-message', { text: 'ok' });

      // @ts-expect-error — undeclared event for this channel
      ctx.channels.get('lobby').broadcast('not-declared', {});

      // @ts-expect-error — too many args for a static channel
      ctx.channels.get('lobby', 'extra');

      // @ts-expect-error — unknown static channel name
      ctx.channels.get('does-not-exist');
    });
  });

  it('family channels: get(family, name) returns Promise<void> kick; bare get(family) is rejected', () => {
    const base = withChannels(server('chat'));
    base
      .use(base.channel(scope('publicRooms', /^room:.+$/), (ch) => ch.outgoing(RoomMessage)))
      .incoming(Send, async (ctx) => {
        const result: Promise<void> = ctx.channels.get('publicRooms', 'room:1').kick('tag', 'r');
        void result;

        // @ts-expect-error — family handle requires a concrete name
        ctx.channels.get('publicRooms');

        // @ts-expect-error — unknown family key
        ctx.channels.get('unknown-family', 'room:1');
      });
  });

  it('inside a channel handler: ctx.channel.kick exists; ctx.channels does NOT', () => {
    const base = withChannels(server('chat'));
    base.use(
      base.channel('lobby', (ch) =>
        ch.outgoing(RoomMessage).incoming(Send, async (ctx) => {
          const r: Promise<void> = ctx.channel.kick('tag', 'reason');
          void r;
          ctx.channel.broadcast('room-message', { text: 'hi' });
          const members: ConnectionInfo[] = ctx.channel.members();
          void members;

          // @ts-expect-error — ctx.channels is removed inside channel-scoped handlers
          ctx.channels;
        }),
      ),
    );
  });

  it('without any channels registered: ctx.channels is absent', () => {
    server('chat').incoming(Send, (ctx) => {
      // @ts-expect-error — no channels registered, ctx.channels does not exist
      ctx.channels;
    });
  });
});
