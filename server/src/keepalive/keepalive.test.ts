import { keepalive } from '~/keepalive/keepalive.ts';
import type { KeepalivePrimitive } from '~/keepalive/keepalive.ts';
import type { PrimitiveKind, PrimitiveRef } from '~/primitive.ts';

const kaPrimitive = keepalive({ pingIntervalMs: 15_000, idleTimeoutMs: 30_000 });
const _kaType: KeepalivePrimitive = kaPrimitive;
void _kaType;

const _tag: 'keepalive' = kaPrimitive.__livething;
const _kind: PrimitiveKind = kaPrimitive.__kind;
const _ping: number = kaPrimitive.pingIntervalMs;
const _idle: number = kaPrimitive.idleTimeoutMs;
void [_tag, _kind, _ping, _idle];

const _ref: PrimitiveRef = keepalive;
const _key: symbol = keepalive.__key;
void [_ref, _key];
