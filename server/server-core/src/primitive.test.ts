/* oxlint-disable @typescript-eslint/no-explicit-any */

import { definePrimitive } from '~/primitive.ts';
import type {
  EngineAccess,
  Primitive,
  PrimitiveFactory,
  PrimitiveIdentity,
  PrimitiveKind,
  PrimitiveRef,
  RequiresManifest,
} from '~/primitive.ts';

// ===========================================================================
// 1. PrimitiveKind — all valid kinds
// ===========================================================================

const _handler: PrimitiveKind = 'handler';
const _contract: PrimitiveKind = 'contract';
const _infra: PrimitiveKind = 'infrastructure';
const _lifecycle: PrimitiveKind = 'lifecycle';
const _scope: PrimitiveKind = 'scope';
const _module: PrimitiveKind = 'module';
void [_handler, _contract, _infra, _lifecycle, _scope, _module];

// @ts-expect-error — invalid kind
const _invalid: PrimitiveKind = 'banana';
void _invalid;

// ===========================================================================
// 2. PrimitiveIdentity — singleton and repeatable forms
// ===========================================================================

const key = Symbol('test');

const _singleton: PrimitiveIdentity = [key];
const _repeatable: PrimitiveIdentity = [key, 'send-message'];
void [_singleton, _repeatable];

// @ts-expect-error — cannot push to readonly tuple
_singleton.push(key);

// ===========================================================================
// 3. PrimitiveRef — dependency reference
// ===========================================================================

const ref: PrimitiveRef = { __key: Symbol('ack') };
const _refKey: symbol = ref.__key;
void _refKey;

// ===========================================================================
// 4. RequiresManifest — all fields optional
// ===========================================================================

const _empty: RequiresManifest = {};
const _full: RequiresManifest = { storage: true, timers: true, hibernation: true };
const _partial: RequiresManifest = { storage: true };
void [_empty, _full, _partial];

// ===========================================================================
// 5. Primitive — base interface with tag discrimination
// ===========================================================================

declare const ackInstance: Primitive<'ack'>;
const _tag: 'ack' = ackInstance.__wskit;
void _tag;

// @ts-expect-error — wrong tag
const _wrongTag: 'incoming' = ackInstance.__wskit;
void _wrongTag;

// ===========================================================================
// 6. definePrimitive — singleton factory (no registrationId)
// ===========================================================================

const ACK_KEY = Symbol('ack');
const ack = definePrimitive({
  tag: 'ack' as const,
  key: ACK_KEY,
  kind: 'infrastructure',
  create() {
    return {};
  },
});

// Factory is callable
const ackPrimitive = ack();
const _ackTag: 'ack' = ackPrimitive.__wskit;
void _ackTag;

// Factory is a PrimitiveRef (for dependency declarations)
const _ackRef: PrimitiveRef = ack;
const _ackKey: symbol = ack.__key;
void [_ackRef, _ackKey];

// ===========================================================================
// 7. definePrimitive — repeatable factory (with registrationId)
// ===========================================================================

const INCOMING_KEY = Symbol('incoming');
const incoming = definePrimitive({
  tag: 'incoming' as const,
  key: INCOMING_KEY,
  kind: 'handler',
  registrationId(event: string, _handler: (payload: any) => void) {
    return event;
  },
  create(event: string, handler: (payload: any) => void) {
    return { event, handler };
  },
});

const incomingPrimitive = incoming('send-message', () => {});
const _inTag: 'incoming' = incomingPrimitive.__wskit;
const _inEvent: string = incomingPrimitive.event;
void [_inTag, _inEvent];

// Factory is also a PrimitiveRef
const _inRef: PrimitiveRef = incoming;
void _inRef;

// ===========================================================================
// 8. definePrimitive — custom data carried on instance
// ===========================================================================

const HEARTBEAT_KEY = Symbol('heartbeat');
const heartbeat = definePrimitive({
  tag: 'heartbeat' as const,
  key: HEARTBEAT_KEY,
  kind: 'infrastructure',
  create(options: { timeout: number }) {
    return { timeout: options.timeout };
  },
});

const hbPrimitive = heartbeat({ timeout: 30000 });
const _hbTimeout: number = hbPrimitive.timeout;
void _hbTimeout;

// ===========================================================================
// 9. definePrimitive — with dependencies and requires
// ===========================================================================

const REPLAY_KEY = Symbol('replay');
const replay = definePrimitive({
  tag: 'replay' as const,
  key: REPLAY_KEY,
  kind: 'infrastructure',
  dependencies: [ack],
  requires: { storage: true },
  create() {
    return {};
  },
});

const replayPrimitive = replay();
const _replayDeps: readonly PrimitiveRef[] = replayPrimitive.__dependencies;
const _replayReqs: RequiresManifest = replayPrimitive.__requires;
void [_replayDeps, _replayReqs];

// ===========================================================================
// 10. definePrimitive — with setup function
// ===========================================================================

const SEQUENCE_KEY = Symbol('sequence');
const sequence = definePrimitive({
  tag: 'sequence' as const,
  key: SEQUENCE_KEY,
  kind: 'infrastructure',
  create() {
    return {};
  },
  setup(engine: EngineAccess) {
    let seq = 0;
    engine.onOutgoing((msg) => {
      msg.payload._seq = ++seq;
      return msg;
    });
  },
});

const seqPrimitive = sequence();
// __setup exists when config has setup
const _hasSetup: ((engine: EngineAccess) => void) | undefined = seqPrimitive.__setup;
void _hasSetup;

// ===========================================================================
// 11. PrimitiveFactory — satisfies both callable and PrimitiveRef
// ===========================================================================

const _factory: PrimitiveFactory<'ack', [], Record<string, never>> = ack;
void _factory;

// Can be used in dependency arrays alongside other refs
const deps: readonly PrimitiveRef[] = [ack, incoming, replay];
void deps;

// ===========================================================================
// 12. Discriminated union works across different primitives
// ===========================================================================

type AnyPrimitive =
  | ReturnType<typeof ack>
  | ReturnType<typeof incoming>
  | ReturnType<typeof heartbeat>;

function handlePrimitive(p: AnyPrimitive) {
  switch (p.__wskit) {
    case 'ack':
      return;
    case 'incoming': {
      const _event: string = p.event;
      void _event;
      return;
    }
    case 'heartbeat': {
      const _timeout: number = p.timeout;
      void _timeout;
      return;
    }
  }
}
void handlePrimitive;
