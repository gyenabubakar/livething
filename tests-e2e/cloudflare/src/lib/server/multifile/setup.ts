// The shared contract. Other files import it to attach handler groups, and
// the top-level handler imports it to add inline lifecycle handlers and call
// `.build()`. The split contract + implement composition fans out from here.
import { channel, contract, incoming, outgoing, t } from '@wskit/server';
import { NotificationPayload, RoomMessagePayload, SendRoomMessagePayload } from './events.ts';

export const multifileContract = contract<Env>('multifile')({
  meta: t<{ username: string }>(),
  definitions: [
    outgoing('notification', NotificationPayload),
    channel('lobby', {
      definitions: [
        outgoing('room-message', RoomMessagePayload),
        incoming('send-room-message', SendRoomMessagePayload),
      ],
    }),
  ],
});
