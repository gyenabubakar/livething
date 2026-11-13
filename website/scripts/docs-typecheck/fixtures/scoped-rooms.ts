// The server and rooms channel from the Scoped Streams & Requests page (server/scoped-rooms.ts).
import { CloseCodes } from '@livething/core';
import { emits, server, t } from '@livething/server';
import { channels } from '@livething/server/channels';
import { RejectAuth } from '@livething/server/errors';
import { serverRequests } from '@livething/server/server-requests';
import { recordedStream, stream } from '@livething/server/streams';
import * as v from 'valibot';
import { verifySession } from './auth';
import { Message } from './base';

export const base = server({
  async authenticate(request) {
    const token = request.headers.get('Authorization')?.replace('Bearer ', '');
    const user = await verifySession(token);
    if (!user) throw RejectAuth(CloseCodes.AUTH_INVALID, 'invalid session');
    return {
      userId: user.id,
      meta: { name: user.name, role: user.role },
    };
  },
  capabilities: [
    channels(),
    stream(),
    recordedStream(),
    serverRequests(),
    emits({
      'mention-result': t<{ delivered: number }>(),
      'ping-result': t<{ alive: boolean }>(),
    }),
  ],
});

export const rooms = base.channel(['rooms', 'room:{roomId}'], {
  capabilities: [
    emits({
      message: t<Message>(),
      mentioned: t<{ from: string }>(),
    }),
    serverRequests({
      'ping-member': {
        out: t<null>(),
        in: v.object({ alive: v.boolean() }),
      },
    }),
  ],
});
