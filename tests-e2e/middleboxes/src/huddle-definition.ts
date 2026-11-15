// The part of Huddle the middlebox lane needs: a message that comes back to its sender, room
// messages that go to every member, and an avatar upload whose preview comes back as bytes.
import { emits, server, t } from '@livething/server';
import { binary } from '@livething/server/binary';
import { channels } from '@livething/server/channels';
import { keepalive } from '@livething/server/keepalive';

export function buildHuddleDefinition() {
  const base = server({
    authenticate(request) {
      return { userId: new URL(request.url).searchParams.get('user') ?? 'guest' };
    },
    capabilities: [
      channels(),
      keepalive(),
      emits({ echoed: t<{ n: number; text: string }>() }),
      binary({ emits: { 'avatar-preview': t<null>() } }),
    ],
  });

  const rooms = base.channel(['rooms', 'room:{roomId}'], {
    presence: false,
    capabilities: [emits({ message: t<{ n: number; from: string }>() })],
  });

  const echo = base.on('echo', {
    run(ctx, input: { n: number; text: string }) {
      ctx.send('echoed', input);
    },
  });

  const sendMessage = rooms.on('send-message', {
    run(ctx, input: { n: number }) {
      ctx.channel.broadcast('message', { n: input.n, from: ctx.user.id });
    },
  });

  const uploadAvatar = base.binary.on('upload-avatar', {
    run(ctx, _input, bytes) {
      ctx.binary.send('avatar-preview', bytes, { info: null });
    },
  });

  return base.assemble({ handlers: [echo, sendMessage, uploadAvatar] });
}
