import { keepalive } from '~/keepalive/keepalive.ts';
import type { KeepalivePrimitive } from '~/keepalive/keepalive.ts';

const kaPrimitive = keepalive({ pingIntervalMs: 15_000, idleTimeoutMs: 30_000 });
const _kaType: KeepalivePrimitive = kaPrimitive;
void _kaType;

const _tag: 'keepalive' = kaPrimitive.__livething;
void _tag;
