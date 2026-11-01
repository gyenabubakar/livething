import { t } from '~/_api/definitions.ts';
import { server } from '~/_define/server.ts';
import { channels } from '~/channel/capability.ts';
import { emits } from '~/emits/emits.ts';
import { scheduled } from './capability.ts';

const base = server({
  capabilities: [
    emits({ maintenanceStarted: t<{ minutes: number }>() }),
    channels(),
    scheduled({ startMaintenance: null }),
  ],
  onShutdown(ctx) {
    ctx.broadcast('maintenanceStarted', { minutes: 0 });
    // @ts-expect-error — not an event this server emits
    ctx.broadcast('maintenanceEnded', {});
    // @ts-expect-error — a connectionless ctx has no current connection
    ctx.send;
  },
});
const general = base.channel('general', {
  capabilities: [emits({ huddleClosing: t<{ reason: string }>() })],
});

base.scheduled('startMaintenance', {
  run(ctx) {
    ctx.broadcast('maintenanceStarted', { minutes: 5 });
    // @ts-expect-error — not an event this server emits
    ctx.broadcast('maintenanceEnded', { minutes: 5 });
    // @ts-expect-error — wrong payload for a declared event
    ctx.broadcast('maintenanceStarted', { minutes: 'five' });

    ctx.users.get('user_9').broadcast('maintenanceStarted', { minutes: 5 });
    // @ts-expect-error — not an event this server emits
    ctx.users.get('user_9').broadcast('maintenanceEnded', {});

    ctx.channels.get(general).broadcast('huddleClosing', { reason: 'maintenance' });
    // @ts-expect-error — not an event of this channel
    ctx.channels.get(general).broadcast('maintenanceStarted', { minutes: 5 });

    ctx.closeConnections({ userId: 'user_9' });
  },
});

const docsBase = server({
  capabilities: [channels(), scheduled({ 'archive-room': { data: t<{ roomId: string }>() } })],
});
const rooms = docsBase.channel(['rooms', 'room:{roomId}'], {
  capabilities: [emits({ 'room-archived': t<{ roomId: string }>() })],
});

docsBase.scheduled('archive-room', {
  run(ctx, data) {
    ctx.channels
      .get(rooms.at({ roomId: data.roomId }))
      .broadcast('room-archived', { roomId: data.roomId });
    // @ts-expect-error — not an event of this channel
    ctx.channels.get(rooms.at({ roomId: data.roomId })).broadcast('room-opened', {});
  },
});
