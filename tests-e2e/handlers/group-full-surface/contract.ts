import { server, emits, t } from '@wskit/server';
import { channels } from '@wskit/server/channels';
import { clientRequests } from '@wskit/server/client-requests';
import { dedup } from '@wskit/server/dedup';
import { intercepts } from '@wskit/server/intercepts';
import { rateLimit } from '@wskit/server/rate-limit';
import { replay } from '@wskit/server/replay';
import { scheduled } from '@wskit/server/scheduled';
import { sequence } from '@wskit/server/sequence';
import { recordedStream, resumableStream, stream } from '@wskit/server/streams';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

export const ChatPayload = v.object({ text: v.string() });
export const LookupReq = v.object({ id: v.string() });
export const LookupRes = v.object({ found: v.boolean(), hit: v.string(), tag: v.string() });
export const FeedChunk = t<{ idx: number }>();
export const PaginateChunk = t<{ row: number }>();
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
    resumableStream(),
    recordedStream(),
    replay.custom(),
    intercepts(),
    emits({
      welcome: t<{ username: string }>(),
      goodbye: t<{ username: string }>(),
      'init-marker': t<{ ran: number }>(),
      'error-marker': t<{ event?: string | undefined; msg: string }>(),
      'validation-marker': t<{ event: string }>(),
      'pre-intercept-marker': t<{ event: string }>(),
      'post-intercept-marker': t<{ text: string }>(),
      'rl-marker': t<{ at: number }>(),
      'replay-marker': t<{ note: string }>(),
      'scheduled-marker': t<{ tickCount: number }>(),
    }),
  ],
});
