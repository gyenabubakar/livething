/**
 * Compile-time fixture: in-handler `ctx.channel.kick(target, ...)` accepts the
 * same targets as the runtime — a user ref, a tag ref, and a whole tag group.
 */
import { t } from '~/_api/definitions.ts';
import { server } from '~/_define/server.ts';
import { channels } from '~/channel/capability.ts';
import { tags } from '~/tags/capability.ts';

const base = server({
  capabilities: [
    channels(),
    tags((ephemeral, persistent) => [
      ephemeral('role', t<string>()),
      persistent('team', t<string>()),
    ]),
  ],
});

const room = base.channel('room');

room.on('moderate', {
  async run(ctx) {
    await ctx.channel.kick(ctx.users.get('u-1').ref(), { reason: 'spam' });
    await ctx.channel.kick(ctx.tags.ephemeral('role').ref('troll'), { reason: 'spam' });
    await ctx.channel.kick(ctx.tags.ephemeral('role'), { reason: 'spam' });
    await ctx.channel.kick(ctx.tags.persistent('team'), { reason: 'spam' });

    // @ts-expect-error a connection ref is not a kick target; close the connection instead
    await ctx.channel.kick(ctx.connection.ref(), { reason: 'spam' });
  },
});
