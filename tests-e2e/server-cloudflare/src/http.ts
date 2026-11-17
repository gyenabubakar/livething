import { emits, server, t } from '@livething/server';
import { bind, http, websocket } from '@livething/server-cloudflare';
import { binary } from '@livething/server/binary';
import { RejectAuth } from '@livething/server/errors';
import { keepalive } from '@livething/server/keepalive';

// A hibernating object, so a stream shows it gets the timers a hibernated socket does not.
const base = server({
  hibernation: true,
  authenticate(request) {
    const url = new URL(request.url);
    if (url.searchParams.has('banned')) throw RejectAuth(4009, 'Banned from Huddle');

    if (url.searchParams.has('expired')) throw RejectAuth(401, 'Log in again');

    return { userId: url.searchParams.get('username') ?? 'ama' };
  },
  capabilities: [
    keepalive({ pingIntervalMs: 200, idleTimeoutMs: 600 }),
    binary({ emits: { 'avatar-preview': t<{ size: number }>() } }),
    emits({ 'message-created': t<{ text: string; by: string }>() }),
  ],
});

const handleSendMessage = base.on('send-message', {
  run(ctx, input) {
    ctx.send('message-created', { text: (input as { text: string }).text, by: ctx.user.id });
  },
});

const handleLeaveHuddle = base.on('leave-huddle', {
  run(ctx) {
    ctx.close(4000, 'left the huddle');
  },
});

const handleUploadAvatar = base.binary.on('upload-avatar', {
  run(ctx, _input, bytes) {
    ctx.binary.send('avatar-preview', bytes.subarray(0, 8), { info: { size: bytes.byteLength } });
  },
});

export const httpDefinition = base.assemble({
  handlers: [handleSendMessage, handleLeaveHuddle, handleUploadAvatar],
});

export class HttpServer extends bind(httpDefinition, {
  transports: [websocket(), http({ maxPostBytes: 1024 })],
  allowedOrigins: ['https://huddle.example'],
}) {}
