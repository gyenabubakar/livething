import { replay } from '~/replay/replay.ts';
import type { ReplayPrimitive } from '~/replay/replay.ts';
import type { ReplaySnapshotValue } from '~/replay/types.ts';

const replayPrimitive = replay();
const _replayType: ReplayPrimitive = replayPrimitive;
void _replayType;

const _tag: 'replay' = replayPrimitive.__livething;
void _tag;

const configuredReplay = replay({
  type: 'snapshot',
  durability: 'best-effort',
  retention: {
    maxAgeMs: 60_000,
    maxMessages: 25,
  },
  exclude: ['typing'],
  snapshotKey(event, payload) {
    const _event: string = event;
    const _payload = payload as { id?: string };
    return _payload.id ?? _event;
  },
  reduce(previous, next) {
    const _previous: ReplaySnapshotValue | null = previous;
    const _next: ReplaySnapshotValue = next;
    void [_previous, _next];

    if (next.event === 'message-deleted') return null;

    return {
      event: 'message-snapshot',
      payload: {
        ...(previous?.payload ?? {}),
        ...next.payload,
      },
    };
  },
});

const _configuredReplay: ReplayPrimitive = configuredReplay;
void _configuredReplay;
