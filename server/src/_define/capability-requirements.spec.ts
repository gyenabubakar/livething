import { resolveCapabilityRequirements } from '~/_define/capability-requirements.ts';
import { describe, expect, it } from 'vitest';
import type { AnyCapability } from '~/_define/capability.ts';
import type { Primitive } from '~/primitive.ts';

function makePrimitive(
  wskit: string,
  requiresCapabilities: readonly string[],
  extra: Record<string, unknown> = {},
): Primitive {
  return {
    __wskit: wskit,
    __kind: 'infrastructure',
    __identity: [Symbol(wskit)],
    __requires: {},
    __requiresCapabilities: requiresCapabilities,
    ...extra,
  } as Primitive;
}

function makeCapability(kind: string): AnyCapability {
  return {
    __wskitCapability: true,
    __primitives: [],
    __features: [],
    __capabilityKind: kind,
  } as unknown as AnyCapability;
}

describe('resolveCapabilityRequirements', () => {
  it('throws on an app missing a required capability, naming the capability and the primitive that needs it', () => {
    const primitives = [makePrimitive('inbox', ['sequence', 'dedup'])];
    expect(() => resolveCapabilityRequirements(primitives, [], { scoped: false })).toThrow(
      '[wskit] The sequence() capability is required by inbox but is not listed. Add sequence() to capabilities.',
    );
  });

  it('builds cleanly on an app that lists every required capability', () => {
    const primitives = [makePrimitive('replay', ['dedup', 'sequence'])];
    const capabilities = [makeCapability('dedup'), makeCapability('sequence')];
    expect(() =>
      resolveCapabilityRequirements(primitives, capabilities, { scoped: false }),
    ).not.toThrow();
  });

  it('records a host-only requirement as a host dependency on a scoped plugin handler, instead of throwing', () => {
    const primitives = [makePrimitive('inbox', ['sequence', 'dedup', 'channels'])];
    const capabilities = [makeCapability('channels')];
    const { hostDependencies } = resolveCapabilityRequirements(primitives, capabilities, {
      scoped: true,
    });
    expect(hostDependencies).toContain('sequence');
    expect(hostDependencies).toContain('dedup');
    expect(hostDependencies).not.toContain('channels');
  });

  it('still throws on a scoped plugin handler missing a capability it could own itself', () => {
    const primitives = [makePrimitive('inbox', ['channels'])];
    expect(() => resolveCapabilityRequirements(primitives, [], { scoped: true })).toThrow(
      '[wskit] The channels() capability is required by inbox but is not listed. Add channels() to capabilities.',
    );
  });

  it('walks a requirement declared on a primitive nested inside a channel, not only top-level ones', () => {
    const nestedInbox = makePrimitive('inbox', ['sequence']);
    const channel = makePrimitive('channel', [], { primitives: [nestedInbox] });
    expect(() => resolveCapabilityRequirements([channel], [], { scoped: false })).toThrow(
      '[wskit] The sequence() capability is required by inbox but is not listed. Add sequence() to capabilities.',
    );
  });

  it('finds a nested requirement and resolves it as a host dependency when scoped and the capability is host-only', () => {
    const nestedReplay = makePrimitive('replay', ['dedup', 'sequence']);
    const channel = makePrimitive('channel', [], { primitives: [nestedReplay] });
    const { hostDependencies } = resolveCapabilityRequirements([channel], [], { scoped: true });
    expect(hostDependencies).toEqual(expect.arrayContaining(['dedup', 'sequence']));
  });
});
