import { emits, server, t } from '@livething/server';
import { channels } from '@livething/server/channels';
import { clientRequests } from '@livething/server/client-requests';
import { dedup } from '@livething/server/dedup';
import { rateLimit } from '@livething/server/rate-limit';
import { scheduled } from '@livething/server/scheduled';
import { sequence } from '@livething/server/sequence';
import { recordedStream, stream } from '@livething/server/streams';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

export const ChatPayload = v.object({ text: v.string() });
export const LookupReq = v.object({ id: v.string() });
export const FeedChunk = t<{ idx: number }>();
export const TokenChunk = t<{ token: string }>();

export const SendMsgPayload = v.object({ text: v.string() });
export const RoomMsgPayload = v.object({ text: v.string(), from: v.string() });

export const BadPayload = v.object({ ok: v.literal(true) });

export const base = server({
  upgrade: (request) => requireUsername(request),
  capabilities: [
    sequence({ persist: true }),
    dedup(),
    rateLimit(),
    clientRequests(),
    channels(),
    scheduled({ tick: null }),
    stream(),
    recordedStream(),
    emits({
      welcome: t<{ username: string }>(),
      goodbye: t<{ username: string }>(),
      'init-marker': t<{ ran: number }>(),
      'error-marker': t<{ event?: string | undefined; msg: string }>(),
      'validation-marker': t<{ event: string }>(),
      'pre-intercept-marker': t<{ event: string }>(),
      'post-intercept-marker': t<{ text: string }>(),
      'rl-marker': t<{ at: number }>(),
      'scheduled-marker': t<{ tickCount: number }>(),
    }),
  ],
});
