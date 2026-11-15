// The app the benchmarks run: a small part of Huddle with top-level echo and requests, rooms whose
// messages go to every member, and binary events: an avatar upload that sends a preview back, and
// screen frames that go to the whole room.
import { emits, server, t } from '@livething/server';
import { binary } from '@livething/server/binary';
import { channels } from '@livething/server/channels';
import { clientRequests } from '@livething/server/client-requests';
import { keepalive } from '@livething/server/keepalive';

/** `keepalive` is for server-sent events, which need it. */
export function buildHuddleDefinition(options = {}) {
  const base = server({
    authenticate(request) {
      return { userId: new URL(request.url).searchParams.get('user') ?? undefined };
    },
    capabilities: [
      channels(),
      clientRequests(),
      emits({ echoed: t() }),
      binary({ emits: { 'avatar-preview': t() } }),
      ...(options.keepalive ? [keepalive()] : []),
    ],
  });

  const rooms = base.channel(['rooms', 'room:{roomId}'], {
    presence: options.presence ?? true,
    capabilities: [emits({ message: t() }), binary({ emits: { 'screen-frame': t() } })],
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

  // The preview is the same bytes, so the step measures moving bytes, not resizing a picture.
  const uploadAvatar = base.binary.on('upload-avatar', {
    run(ctx, _input, bytes) {
      ctx.binary.send('avatar-preview', bytes, { info: null });
    },
  });

  const shareScreenFrame = rooms.binary.on('share-screen-frame', {
    run(ctx, _input, bytes) {
      ctx.channel.binary.broadcast('screen-frame', bytes, { info: { from: ctx.user.id } });
    },
  });

  return base.assemble({
    handlers: [echo, sendMessage, getProfile, uploadAvatar, shareScreenFrame],
  });
}
