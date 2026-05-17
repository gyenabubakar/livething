import { server } from '~/_builder/server-builder.ts';
import { withChannels } from '~/channel/with.ts';
import { event } from '~/event.ts';
import { persistentMarker } from '~/persistence/channel-marker.ts';
import { withPersistence } from '~/persistence/with.ts';
import { describe, expect, it } from 'vitest';

const Msg = event('msg', (p: unknown) => p as { text: string });

describe('persistentMarker primitive', () => {
  it('skips registration when scope has no channelKey (top-level)', () => {
    let called = false;
    persistentMarker(false).__setup?.({
      getScopeInfo: () => ({}),
      setChannelPersistent: () => {
        called = true;
      },
    } as never);
    expect(called).toBe(false);
  });

  it('records the per-channel override when scope has a channelKey', () => {
    const calls: Array<{ key: string; enabled: boolean }> = [];
    persistentMarker(false).__setup?.({
      getScopeInfo: () => ({ channelKey: 'team-eng' }),
      setChannelPersistent: (key: string, enabled: boolean) => {
        calls.push({ key, enabled });
      },
    } as never);
    expect(calls).toEqual([{ key: 'team-eng', enabled: false }]);
  });
});

describe('channel.persistent(false) wires through the builder', () => {
  it('attaches a persistent-marker primitive to the channel scope', () => {
    const base = withPersistence(withChannels(server('chat'))).enablePersistence();
    const typing = base.channel('typing', (c) => c.persistent(false).outgoing(Msg));
    const def = base.use(typing).build();

    const channelPrim = def.primitives.find((p) => p.__wskit === 'channel') as
      | { primitives?: { __wskit: string }[] }
      | undefined;
    const markers = channelPrim?.primitives?.filter((p) => p.__wskit === 'persistent-marker');
    expect(markers).toHaveLength(1);
  });

  it('omitted .persistent(...) leaves the channel persistent by default', () => {
    const base = withPersistence(withChannels(server('chat'))).enablePersistence();
    const teamEng = base.channel('team-eng', (c) => c.outgoing(Msg));
    const def = base.use(teamEng).build();

    const channelPrim = def.primitives.find((p) => p.__wskit === 'channel') as
      | { primitives?: { __wskit: string }[] }
      | undefined;
    const markers = channelPrim?.primitives?.filter((p) => p.__wskit === 'persistent-marker');
    expect(markers ?? []).toHaveLength(0);
  });
});
