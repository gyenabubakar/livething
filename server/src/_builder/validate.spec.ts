import { describe, expect, it } from 'vitest';
import type { Primitive, PrimitiveRef } from '~/primitive.ts';
import { validateBuild } from './validate.ts';

type AnyPrimitive = Primitive & {
  primitives?: readonly Primitive[];
};

function ref(label: string): PrimitiveRef {
  return Object.assign(() => ({}) as Primitive, {
    __key: Symbol(label),
    __kind: 'feature' as const,
  }) as unknown as PrimitiveRef;
}

function leaf(
  tag: string,
  key: PrimitiveRef,
  registrationId: string | undefined = undefined,
  dependencies: readonly PrimitiveRef[] = [],
): AnyPrimitive {
  return {
    __wskit: tag,
    __kind: 'feature' as const,
    __identity: [key.__key, registrationId] as const,
    __dependencies: dependencies,
    __requires: {},
  } as unknown as AnyPrimitive;
}

function nested(
  tag: 'channel' | 'namespace' | 'group',
  registrationId: string | undefined,
  primitives: readonly AnyPrimitive[],
): AnyPrimitive {
  return {
    __wskit: tag,
    __kind: 'feature' as const,
    __identity: [Symbol(`${tag}:${registrationId ?? ''}`), registrationId] as const,
    __dependencies: [],
    __requires: {},
    primitives,
  } as unknown as AnyPrimitive;
}

describe('validateBuild — scope-local dependency rules', () => {
  it('a server-level primitive satisfies a server-level dependent', () => {
    const replay = ref('replay');
    expect(() =>
      validateBuild([
        leaf('replay', replay),
        leaf('replayConsumer', ref('rc'), undefined, [replay]),
      ]),
    ).not.toThrow();
  });

  it('a server-level primitive is visible inside channels', () => {
    const ack = ref('ack');
    expect(() =>
      validateBuild([
        leaf('ack', ack),
        nested('channel', 'room', [leaf('channelAckUser', ref('cau'), undefined, [ack])]),
      ]),
    ).not.toThrow();
  });

  it('a server-level primitive is visible inside namespaces (namespace inherits root)', () => {
    const replay = ref('replay');
    expect(() =>
      validateBuild([
        leaf('replay', replay),
        nested('namespace', 'ns', [leaf('nsConsumer', ref('nc'), undefined, [replay])]),
      ]),
    ).not.toThrow();
  });

  it('a channel-local primitive does NOT satisfy a dependency in a sibling channel', () => {
    const replay = ref('replay');
    expect(() =>
      validateBuild([
        nested('channel', 'room', [leaf('replay', replay)]),
        nested('channel', 'house', [leaf('houseConsumer', ref('hc'), undefined, [replay])]),
      ]),
    ).toThrow(/missing dependency/);
  });

  it('a channel-local primitive satisfies its own scope', () => {
    const replay = ref('replay');
    expect(() =>
      validateBuild([
        nested('channel', 'room', [
          leaf('replay', replay),
          leaf('roomConsumer', ref('rc'), undefined, [replay]),
        ]),
      ]),
    ).not.toThrow();
  });

  it('a namespace-local primitive does NOT leak out to the root scope', () => {
    const inner = ref('inner');
    expect(() =>
      validateBuild([
        nested('namespace', 'ns', [leaf('inner', inner)]),
        leaf('rootConsumer', ref('rc'), undefined, [inner]),
      ]),
    ).toThrow(/missing dependency/);
  });

  it('a group at the server level expands into server-level refs', () => {
    const ack = ref('ack');
    expect(() =>
      validateBuild([
        nested('group', undefined, [leaf('ack', ack)]),
        leaf('rootConsumer', ref('rc'), undefined, [ack]),
      ]),
    ).not.toThrow();
  });

  it('a group inside a channel keeps its refs scoped to that channel', () => {
    const localAck = ref('localAck');
    expect(() =>
      validateBuild([
        nested('channel', 'room', [nested('group', undefined, [leaf('localAck', localAck)])]),
        nested('channel', 'house', [leaf('houseConsumer', ref('hc'), undefined, [localAck])]),
      ]),
    ).toThrow(/missing dependency/);
  });

  it('throws when a dependency is registered nowhere', () => {
    const missing = ref('missing');
    expect(() => validateBuild([leaf('orphan', ref('o'), undefined, [missing])])).toThrow(
      /missing dependency/,
    );
  });
});
