import { resolveCapabilityRequirements } from '~/_define/capability-requirements.ts';
import { channelOnlyCapability, stampKind, withCapabilityKind } from '~/_define/capability.ts';
import { channels } from '~/channel/capability.ts';
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
      "[wskit] The sequence() capability is required by inbox but is not listed. Add sequence() to this channel's capabilities, or to define({ capabilities: [...] }).",
    );
  });

  it('finds a nested requirement and resolves it as a host dependency when scoped and the capability is host-only', () => {
    const nestedReplay = makePrimitive('replay', ['dedup', 'sequence']);
    const channel = makePrimitive('channel', [], { primitives: [nestedReplay] });
    const { hostDependencies } = resolveCapabilityRequirements([channel], [], { scoped: true });
    expect(hostDependencies).toEqual(expect.arrayContaining(['dedup', 'sequence']));
  });

  it("satisfies a nested requirement from the channel's own declared capability kinds before falling back to the host", () => {
    const nestedInbox = makePrimitive('inbox', ['sequence']);
    const nestedReadReceipts = makePrimitive('read-receipts', ['inbox', 'sequence']);
    const channel = makePrimitive('channel', [], {
      primitives: [nestedInbox, nestedReadReceipts],
      __capabilityKinds: new Set(['inbox']),
    });
    const capabilities = [makeCapability('sequence')];
    expect(() =>
      resolveCapabilityRequirements([channel], capabilities, { scoped: false }),
    ).not.toThrow();
  });

  it("throws when a channel-nested requirement is satisfied by neither the channel's own list nor the host", () => {
    const nestedReadReceipts = makePrimitive('read-receipts', ['inbox', 'sequence']);
    const channel = makePrimitive('channel', [], { primitives: [nestedReadReceipts] });
    const capabilities = [makeCapability('sequence')];
    expect(() => resolveCapabilityRequirements([channel], capabilities, { scoped: false })).toThrow(
      "[wskit] The inbox() capability is required by read-receipts but is not listed. Add inbox() to this channel's capabilities, or to define({ capabilities: [...] }).",
    );
  });

  it('does not let a sibling channel satisfy a requirement — each channel is its own local scope', () => {
    const nestedInbox = makePrimitive('inbox', ['sequence']);
    const inboxChannel = makePrimitive('channel', [], { primitives: [nestedInbox] });
    const nestedReadReceipts = makePrimitive('read-receipts', ['inbox', 'sequence']);
    const readReceiptsChannel = makePrimitive('channel', [], {
      primitives: [nestedReadReceipts],
    });
    const capabilities = [makeCapability('sequence')];
    expect(() =>
      resolveCapabilityRequirements([inboxChannel, readReceiptsChannel], capabilities, {
        scoped: false,
      }),
    ).toThrow(/The inbox\(\) capability is required by read-receipts/);
  });

  it(
    'resolves a channel-nested requirement by the declared capability kind, not by the ' +
      "requiring capability's primitive tag — a tag-based matcher would miss this because the " +
      'two channel-only capabilities below use primitive tags that differ from their kinds',
    () => {
      const PROVIDER_KIND = 'mismatched-provider';
      const provides = withCapabilityKind(function provides(): AnyCapability {
        const cap = channelOnlyCapability<{}, never, never>([]);
        (cap as { __buildChannelPrimitive?: () => Primitive }).__buildChannelPrimitive = () =>
          makePrimitive('totally-different-primitive-tag', []);
        return stampKind(cap, PROVIDER_KIND);
      }, PROVIDER_KIND);

      const NEEDS_KIND = 'mismatched-needer';
      const needsProvider = withCapabilityKind(function needsProvider(): AnyCapability {
        const cap = channelOnlyCapability<{}, never, never>([]);
        (cap as { __buildChannelPrimitive?: () => Primitive }).__buildChannelPrimitive = () =>
          makePrimitive('another-different-primitive-tag', [PROVIDER_KIND]);
        return stampKind(cap, NEEDS_KIND);
      }, NEEDS_KIND);

      const channelBuilder = channels().__channelFactory(
        'room',
        { capabilities: [provides(), needsProvider()] },
        { streamBuilders: {} },
      ) as unknown as { __build: () => Primitive };

      expect(() =>
        resolveCapabilityRequirements([channelBuilder.__build()], [], { scoped: false }),
      ).not.toThrow();
    },
  );
});
