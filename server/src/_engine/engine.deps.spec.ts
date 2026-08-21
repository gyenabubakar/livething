import { commonDeps } from '~/_engine/engine.deps.ts';
import { CrossInstanceRef } from '~/errors/errors.ts';
import { describe, expect, it, vi } from 'vitest';
import type { EngineCore } from '~/_engine/core.ts';

describe('common engine deps', () => {
  it('rejects foreign channel recipients before resolving local members', () => {
    const core = {
      engineInstanceId: 'local',
      channelMembers: new Map(),
      hooks: { contextExtenders: [] },
      usesTags: () => false,
      isTagGroupDeclared: () => false,
      getTagGroupSchema: () => undefined,
      channelHandleAugmenters: [],
    } as unknown as EngineCore;

    const deps = commonDeps(core);
    expect(() =>
      deps.sendToChannelRecipient({
        channelName: 'room',
        channelFamily: null,
        to: { __wskit: 'connection-ref', id: 'peer', instance: 'other', userId: 'peer' },
        event: 'message',
        payload: {},
      }),
    ).toThrow(/cross-instance-ref/);

    let thrown: unknown;
    try {
      deps.sendToChannelRecipient({
        channelName: 'room',
        channelFamily: null,
        to: { __wskit: 'user-ref', id: 'peer', instance: 'other' },
        event: 'message',
        payload: {},
      });
    } catch (error) {
      thrown = error;
    }
    expect(CrossInstanceRef.matches(thrown)).toBe(true);
  });

  it('rejects a foreign user target before channel kick resolution', async () => {
    const kickChannelMembers = vi.fn(() => Promise.resolve());
    const core = {
      engineInstanceId: 'local',
      channelMembers: new Map(),
      channelService: { kickChannelMembers },
      hooks: { contextExtenders: [] },
      usesTags: () => false,
      isTagGroupDeclared: () => false,
      getTagGroupSchema: () => undefined,
      channelHandleAugmenters: [],
    } as unknown as EngineCore;

    const deps = commonDeps(core);
    const foreign = { __wskit: 'user-ref' as const, id: 'alice', instance: 'other' };

    let thrown: unknown;
    try {
      await deps.kickChannelMembers({
        channelName: 'room',
        channelFamily: null,
        target: foreign,
        reason: 'moderation',
      });
    } catch (error) {
      thrown = error;
    }

    expect(CrossInstanceRef.matches(thrown)).toBe(true);
    expect(kickChannelMembers).not.toHaveBeenCalled();
  });
});
