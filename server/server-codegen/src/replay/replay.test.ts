import { replay } from '~/replay/replay.ts';
import type { PrimitiveKind, PrimitiveRef } from '~/primitive.ts';
import type { ReplayPrimitive } from '~/replay/replay.ts';
import type { ReplayDurability, ReplayType } from '~/replay/types.ts';

const replayPrimitive = replay();
const _replayType: ReplayPrimitive = replayPrimitive;
void _replayType;

const _tag: 'replay' = replayPrimitive.__wskit;
const _kind: PrimitiveKind = replayPrimitive.__kind;
void [_tag, _kind];

const _ref: PrimitiveRef = replay;
const _key: symbol = replay.__key;
void [_ref, _key];

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
});

const _configuredReplay: ReplayPrimitive = configuredReplay;
const _type: ReplayType | undefined = configuredReplay.options.type;
const _durability: ReplayDurability | undefined = configuredReplay.options.durability;
void [_configuredReplay, _type, _durability];
