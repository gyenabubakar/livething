import { LiveThingConfigError, RejoinRejected } from '@livething/core';
import { createTestSql } from '~/_test/sql.ts';
import { autoRejoinIdentity } from '~/channel/rejoin.ts';
import {
  ensureMembershipSchema,
  insertMembership,
  listMembershipsByUser,
} from '~/channel/storage.ts';
import { describe, expect, it, vi } from 'vitest';
import type { SendProtocolMessageOptions } from '~/_engine/runtime/wire.ts';

function fakeConnection(userId: string) {
  return { id: 'c-1', userId } as never;
}

describe('autoRejoinIdentity', () => {
  it('no-ops when the user id is empty', async () => {
    const sql = createTestSql();
    ensureMembershipSchema(sql);
    const subscribe = vi.fn<
      (
        connection: never,
        opts: {
          channelName: string;
          channelFamily: string | null;
          payload: unknown;
          rejoining: boolean;
        },
      ) => Promise<void>
    >(async () => {});
    const sendProtocolMessage = vi.fn();

    await autoRejoinIdentity(
      { sql, subscribeConnectionAsServer: subscribe, sendProtocolMessage },
      fakeConnection(''),
    );
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('no-ops when the user has no stored memberships', async () => {
    const sql = createTestSql();
    ensureMembershipSchema(sql);
    const subscribe = vi.fn<
      (
        connection: never,
        opts: {
          channelName: string;
          channelFamily: string | null;
          payload: unknown;
          rejoining: boolean;
        },
      ) => Promise<void>
    >(async () => {});

    await autoRejoinIdentity(
      {
        sql,
        subscribeConnectionAsServer: subscribe,
        sendProtocolMessage: () => {},
      },
      fakeConnection('u-42'),
    );
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('calls subscribeConnectionAsServer for every stored membership', async () => {
    const sql = createTestSql();
    ensureMembershipSchema(sql);
    insertMembership(sql, { userId: 'u-42', channelName: 'lobby', channelFamily: null });
    insertMembership(sql, { userId: 'u-42', channelName: 'room', channelFamily: 'room:abc' });
    const subscribe = vi.fn<
      (
        connection: never,
        opts: {
          channelName: string;
          channelFamily: string | null;
          payload: unknown;
          rejoining: boolean;
        },
      ) => Promise<void>
    >(async () => {});

    await autoRejoinIdentity(
      {
        sql,
        subscribeConnectionAsServer: subscribe,
        sendProtocolMessage: () => {},
      },
      fakeConnection('u-42'),
    );
    expect(subscribe).toHaveBeenCalledTimes(2);
    const calls = subscribe.mock.calls.map((c) => ({
      name: c[1]?.channelName,
      scope: c[1]?.channelFamily,
    }));
    expect(calls).toContainEqual({ name: 'lobby', scope: null });
    expect(calls).toContainEqual({ name: 'room', scope: 'room:abc' });
  });

  it('on subscribe rejection drops the durable row and sends scoped _error', async () => {
    const sql = createTestSql();
    ensureMembershipSchema(sql);
    insertMembership(sql, { userId: 'u-42', channelName: 'team-eng', channelFamily: null });

    const subscribe = vi.fn(async () => {
      throw RejoinRejected({ message: 'not on the eng team' });
    });
    const sent: Array<{
      event: string;
      payload: Record<string, unknown>;
      livething: Record<string, unknown>;
    }> = [];

    await autoRejoinIdentity(
      {
        sql,
        subscribeConnectionAsServer: subscribe,
        sendProtocolMessage: (_c, { event, payload, livething }: SendProtocolMessageOptions) =>
          sent.push({ event, payload, livething }),
      },
      fakeConnection('u-42'),
    );

    expect(listMembershipsByUser(sql, 'u-42')).toHaveLength(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.event).toBe('__error__');
    expect(sent[0]!.livething.channel).toBe('team-eng');
    expect(sent[0]!.payload.code).toBe('rejoin-rejected');

    expect((sent[0]!.payload.detail as { message: string }).message).toBe('not on the eng team');
  });

  it('propagates a config error and keeps the durable row', async () => {
    const sql = createTestSql();
    ensureMembershipSchema(sql);
    insertMembership(sql, { userId: 'u-42', channelName: 'team-eng', channelFamily: null });

    const subscribe = vi.fn(async () => {
      throw new LiveThingConfigError('misconfigured gate');
    });
    const sent: unknown[] = [];

    await expect(
      autoRejoinIdentity(
        {
          sql,
          subscribeConnectionAsServer: subscribe,
          sendProtocolMessage: () => sent.push(1),
        },
        fakeConnection('u-42'),
      ),
    ).rejects.toBeInstanceOf(LiveThingConfigError);

    expect(listMembershipsByUser(sql, 'u-42')).toHaveLength(1);
    expect(sent).toHaveLength(0);
  });

  it('propagates an internal/storage error and keeps the durable row', async () => {
    const sql = createTestSql();
    ensureMembershipSchema(sql);
    insertMembership(sql, { userId: 'u-42', channelName: 'team-eng', channelFamily: null });

    const subscribe = vi.fn(async () => {
      throw new Error('transient storage failure');
    });
    const sent: unknown[] = [];

    await expect(
      autoRejoinIdentity(
        {
          sql,
          subscribeConnectionAsServer: subscribe,
          sendProtocolMessage: () => sent.push(1),
        },
        fakeConnection('u-42'),
      ),
    ).rejects.toThrow('transient storage failure');

    expect(listMembershipsByUser(sql, 'u-42')).toHaveLength(1);
    expect(sent).toHaveLength(0);
  });

  it('one rejection does not stop the rest of the rejoin', async () => {
    const sql = createTestSql();
    ensureMembershipSchema(sql);
    insertMembership(sql, { userId: 'u-42', channelName: 'room-1', channelFamily: null });
    insertMembership(sql, { userId: 'u-42', channelName: 'room-2', channelFamily: null });
    insertMembership(sql, { userId: 'u-42', channelName: 'room-3', channelFamily: null });

    let nth = 0;
    const subscribe = vi.fn(async () => {
      nth++;
      if (nth === 2) throw RejoinRejected({ message: 'gate-rejected on room-2' });
    });

    await autoRejoinIdentity(
      {
        sql,
        subscribeConnectionAsServer: subscribe,
        sendProtocolMessage: () => {},
      },
      fakeConnection('u-42'),
    );

    expect(subscribe).toHaveBeenCalledTimes(3);
    const remaining = listMembershipsByUser(sql, 'u-42').map((r) => r.channelName);
    expect(remaining.sort()).toEqual(['room-1', 'room-3']);
  });
});
