// The app both benchmarks run: a small part of Huddle with top-level echo and requests, and rooms
// whose messages go to every member.
import { emits, server, t } from '@livething/server';
import { channels } from '@livething/server/channels';
import { clientRequests } from '@livething/server/client-requests';
import { keepalive } from '@livething/server/keepalive';

export function buildHuddleDefinition(options = {}) {
  const keepalivePings = options.keepalivePings ?? false;
  const base = server({
    authenticate(request) {
      return { userId: new URL(request.url).searchParams.get('user') ?? undefined };
    },
    capabilities: [
      channels(),
      clientRequests(),
      emits({ echoed: t() }),
      ...(keepalivePings ? [keepalive()] : []),
    ],
  });

  const rooms = base.channel(['rooms', 'room:{roomId}'], {
    capabilities: [emits({ message: t() })],
  });

  const echo = base.on('echo', {
    run(ctx, input) {
      ctx.send('echoed', input);
    },
  });

  const sendMessage = rooms.on('send-message', {
    run(ctx, input) {
      ctx.channel.broadcast('message', { text: input.text, from: ctx.user.id });
    },
  });

  const getProfile = base.request('get-profile', {
    run(ctx) {
      return { userId: ctx.user.id };
    },
  });

  return base.assemble({ handlers: [echo, sendMessage, getProfile] });
}
