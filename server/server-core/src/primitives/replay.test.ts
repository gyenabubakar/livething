import { replay } from '~/primitives/replay.ts';
import type { PrimitiveKind, PrimitiveRef } from '~/primitives/define.ts';
import type { ReplayPrimitive } from '~/primitives/replay.ts';

const replayPrimitive = replay();
const _replayType: ReplayPrimitive = replayPrimitive;
void _replayType;

const _tag: 'replay' = replayPrimitive.__wskit;
const _kind: PrimitiveKind = replayPrimitive.__kind;
void [_tag, _kind];

const _ref: PrimitiveRef = replay;
const _key: symbol = replay.__key;
void [_ref, _key];

const typedReplay = replay<{
  sendReplay(
    event: 'message',
    payload: { text: string },
    wire: { seq: number; messageId: string },
  ): void;
}>({
  onReplay(ctx, since) {
    ctx.sendReplay('message', { text: 'history' }, { seq: 1, messageId: 'm1' });
    const _since: number = since;
    void _since;
  },
});

const _typedReplay: ReplayPrimitive = typedReplay;
void _typedReplay;
