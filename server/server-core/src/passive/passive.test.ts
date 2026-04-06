import { ack } from '~/ack/ack.ts';
import { outgoing } from '~/outgoing/outgoing.ts';
import { passive } from '~/passive/passive.ts';
import { replay } from '~/replay/replay.ts';
import { t } from '~/t.ts';
import type { PassivePrimitive } from '~/passive/passive.ts';
import type { PrimitiveKind, PrimitiveRef } from '~/primitive.ts';

const passivePrimitive = passive();
const _passiveType: PassivePrimitive = passivePrimitive;
void _passiveType;

const _tag: 'passive' = passivePrimitive.__wskit;
const _kind: PrimitiveKind = passivePrimitive.__kind;
void [_tag, _kind];

const grouped = passive();
const _groupedTag: 'passive' = grouped.__wskit;
void _groupedTag;

const _ref: PrimitiveRef = passive;
const _key: symbol = passive.__key;
void [_ref, _key];

// @ts-expect-error — ack() changes ctx, so it cannot go in passive()
passive(ack());

// @ts-expect-error — replay() changes ctx, so it cannot go in passive()
passive(replay());

// @ts-expect-error — outgoing() is a contract primitive, not passive infrastructure
passive(outgoing('message', t<{ text: string }>()));
