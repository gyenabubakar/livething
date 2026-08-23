import * as EngineDeps from '~/_engine/engine.deps.ts';
import * as EngineConnectionRuntime from '~/_engine/runtime/connection.ts';
import * as EngineHibernation from '~/_engine/runtime/hibernation.ts';
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

    const deps = EngineDeps.commonDeps(core);
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

    const deps = EngineDeps.commonDeps(core);
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

describe('connection close dependencies', () => {
  it('passes hibernation-state cleanup into the connection close runtime', async () => {
    const connection = { id: 'conn_1' };
    const core = {
      compiled: {},
      connections: new Map([['conn_1', connection]]),
      usersByKey: new Map(),
      tagMembers: new Map(),
      wsToConnectionId: new Map(),
      activeStreams: new Map(),
      hooks: { connectionCleanup: [] },
      logger: { error: vi.fn() },
    } as unknown as EngineCore;
    const deleteState = vi
      .spyOn(EngineHibernation, 'deleteConnectionState')
      .mockImplementation(() => {});
    const close = vi.spyOn(EngineConnectionRuntime, 'handleConnectionClose').mockResolvedValue();

    await EngineDeps.handleConnectionClose(core, {
      connection: connection as never,
      code: 1000,
      reason: 'bye',
    });

    const runtime = close.mock.calls[0]![0] as {
      deleteConnectionState(connectionId: string): void;
    };
    runtime.deleteConnectionState('conn_1');
    expect(deleteState).toHaveBeenCalledWith(core, 'conn_1');
  });
});
