/* oxlint-disable @typescript-eslint/no-explicit-any */

import { createPrimitiveBase } from '~/primitive.ts';
import type {
  Primitive,
  PrimitiveDefinition,
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

// Both are readonly tuples
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

// @ts-expect-error — unknown field
const _unknown: RequiresManifest = { webhookRouter: true };
void _unknown;

// ===========================================================================
// 5. Primitive — base interface with tag discrimination
// ===========================================================================

// A concrete primitive type narrows the tag
interface AckPrimitive extends Primitive<'ack'> {
  readonly __kind: 'infrastructure';
}

const ackInstance: AckPrimitive = {
  __wskit: 'ack',
  __kind: 'infrastructure',
  __identity: [Symbol('ack')],
  __dependencies: [],
  __requires: {},
};

// Tag is narrowed to literal
const _tag: 'ack' = ackInstance.__wskit;
void _tag;

// @ts-expect-error — wrong tag
const _wrongTag: 'incoming' = ackInstance.__wskit;
void _wrongTag;

// ===========================================================================
// 6. Primitive — discriminated union works
// ===========================================================================

interface IncomingPrimitive extends Primitive<'incoming'> {
  readonly event: string;
}

interface OutgoingPrimitive extends Primitive<'outgoing'> {
  readonly event: string;
}

type AnyPrimitive = AckPrimitive | IncomingPrimitive | OutgoingPrimitive;

function handlePrimitive(p: AnyPrimitive) {
  switch (p.__wskit) {
    case 'ack':
      return;
    case 'incoming': {
      const _event: string = p.event;
      void _event;
      return;
    }
    case 'outgoing': {
      const _event: string = p.event;
      void _event;
      return;
    }
  }
}
void handlePrimitive;

// ===========================================================================
// 7. PrimitiveDefinition — carries factory config
// ===========================================================================

const ACK_KEY = Symbol('ack');
const _ackDef: PrimitiveDefinition<'ack', []> = {
  tag: 'ack',
  key: ACK_KEY,
  kind: 'infrastructure',
};
void _ackDef;

const INCOMING_KEY = Symbol('incoming');
const _incomingDef: PrimitiveDefinition<'incoming', [event: string]> = {
  tag: 'incoming',
  key: INCOMING_KEY,
  kind: 'handler',
  registrationId(event: string) {
    return event;
  },
};
void _incomingDef;

// ===========================================================================
// 8. createPrimitiveBase — produces correct base fields
// ===========================================================================

// Singleton (no registrationId)
const ackBase = createPrimitiveBase({
  tag: 'ack' as const,
  key: ACK_KEY,
  kind: 'infrastructure' as const,
});
const _ackTag: 'ack' = ackBase.__wskit;
const _ackKind: PrimitiveKind = ackBase.__kind;
const _ackId: PrimitiveIdentity = ackBase.__identity;
void [_ackTag, _ackKind, _ackId];

// Repeatable (with registrationId)
const incomingBase = createPrimitiveBase(
  {
    tag: 'incoming' as const,
    key: INCOMING_KEY,
    kind: 'handler' as const,
    registrationId(event: string) {
      return event;
    },
  },
  'send-message',
);
const _inTag: 'incoming' = incomingBase.__wskit;
const _inKind: PrimitiveKind = incomingBase.__kind;
const _inId: PrimitiveIdentity = incomingBase.__identity;
void [_inTag, _inKind, _inId];

// With dependencies and requires
const replayBase = createPrimitiveBase({
  tag: 'replay' as const,
  key: Symbol('replay'),
  kind: 'infrastructure' as const,
  dependencies: [{ __key: Symbol('sequence') }, { __key: Symbol('dedup') }],
  requires: { storage: true },
});
const _replayDeps: readonly PrimitiveRef[] = replayBase.__dependencies;
const _replayReqs: RequiresManifest = replayBase.__requires;
void [_replayDeps, _replayReqs];
