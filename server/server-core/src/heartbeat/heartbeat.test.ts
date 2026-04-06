import { heartbeat } from '~/heartbeat/heartbeat.ts';
import type { HeartbeatPrimitive } from '~/heartbeat/heartbeat.ts';
import type { PrimitiveKind, PrimitiveRef } from '~/primitive.ts';

const hbPrimitive = heartbeat({ timeout: 30_000 });
const _hbType: HeartbeatPrimitive = hbPrimitive;
void _hbType;

const _tag: 'heartbeat' = hbPrimitive.__wskit;
const _kind: PrimitiveKind = hbPrimitive.__kind;
const _timeout: number = hbPrimitive.timeout;
void [_tag, _kind, _timeout];

const _ref: PrimitiveRef = heartbeat;
const _key: symbol = heartbeat.__key;
void [_ref, _key];
