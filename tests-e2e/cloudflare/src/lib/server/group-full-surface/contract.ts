import {
  channel,
  contract,
  incoming,
  namespace,
  outgoing,
  recordedStream,
  request,
  resumableStream,
  scheduled,
  stream,
  t,
} from '@wskit/server';
import * as v from 'valibot';

const ChatPayload = v.object({ text: v.string() });
const LookupReq = v.object({ id: v.string() });
const LookupRes = v.object({ found: v.boolean(), hit: v.string() });
const FeedChunk = v.object({ idx: v.number() });
const PaginateChunk = v.object({ row: v.number() });
const TokenChunk = v.object({ token: v.string() });

const SendMsgPayload = v.object({ text: v.string() });
const RoomMsgPayload = v.object({ text: v.string(), from: v.string() });
const V1PingPayload = v.object({});
const V1PongPayload = v.object({});

const WelcomePayload = v.object({ username: v.string() });
const GoodbyePayload = v.object({ username: v.string() });
const InitMarker = v.object({ ran: v.number() });
const ErrorMarker = v.object({ event: v.optional(v.string()), msg: v.string() });
const ValidationMarker = v.object({ event: v.string() });
const BinaryMarker = v.object({ size: v.number() });
const PreInterceptMarker = v.object({ event: v.string() });
const PostInterceptMarker = v.object({ text: v.string() });
const RlMarker = v.object({ at: v.number() });
const ReplayMarker = v.object({ note: v.string() });
const ScheduledMarker = v.object({ tickCount: v.number() });
const BadPayload = v.object({ ok: v.literal(true) });

export const groupFullSurfaceContract = contract<Env>('group-full-surface')({
  persistence: true,
  binary: true,
  sequence: { persist: true },
  dedup: true,
  meta: t<{ username: string }>(),
  definitions: [
    incoming('chat', ChatPayload),
    request('lookup', { payload: LookupReq, response: LookupRes }),
    stream('feed', { payload: v.object({}), chunk: FeedChunk }),
    resumableStream('paginate', { payload: v.object({}), chunk: PaginateChunk }),
    recordedStream('tokens', { payload: v.object({}), chunk: TokenChunk, maxChunks: 100 }),
    scheduled('tick'),

    // Test-harness incomings used by the spec to drive lifecycle paths.
    incoming('bang', v.object({})),
    incoming('bad-payload', BadPayload),
    incoming('check-init', v.object({})),
    incoming('check-disconnect-log', v.object({ identity: v.string() })),
    incoming('check-scheduled', v.object({})),
    incoming('start-tick', v.object({})),
    incoming('emit-replay-marker', v.object({ note: v.string() })),

    channel('rooms', {
      definitions: [incoming('send-msg', SendMsgPayload), outgoing('room-msg', RoomMsgPayload)],
    }),

    namespace('v1', {
      definitions: [incoming('v1-ping', V1PingPayload), outgoing('v1-pong', V1PongPayload)],
    }),

    outgoing('welcome', WelcomePayload),
    outgoing('goodbye', GoodbyePayload),
    outgoing('init-marker', InitMarker),
    outgoing('error-marker', ErrorMarker),
    outgoing('validation-marker', ValidationMarker),
    outgoing('binary-marker', BinaryMarker),
    outgoing('pre-intercept-marker', PreInterceptMarker),
    outgoing('post-intercept-marker', PostInterceptMarker),
    outgoing('rl-marker', RlMarker),
    outgoing('replay-marker', ReplayMarker),
    outgoing('scheduled-marker', ScheduledMarker),
  ],
});
