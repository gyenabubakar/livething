import { RejoinRejected, WSKitConfigError } from '@wskit/core';
import { createTestSql } from '~/_test/sql.ts';
import { autoRejoinIdentity, restorePersistentTags } from '~/persistence/rejoin.ts';
import {
  ensurePersistenceSchema,
  insertMembership,
  listMembershipsByUser,
} from '~/persistence/storage.ts';
import { insertTag, listTagsByUser } from '~/tags/storage.ts';
import * as v from 'valibot';
import { describe, expect, it, vi } from 'vitest';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';
import type { SendProtocolMessageOptions } from '~/_engine/runtime/wire.ts';

function fakeConnection(userId: string) {
  return { id: 'c-1', userId } as never;
}

describe('autoRejoinIdentity', () => {
  it('no-ops when the user id is empty', async () => {
    const sql = createTestSql();
    ensurePersistenceSchema(sql);
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
      { sql, tagMembers: new Map(), subscribeConnectionAsServer: subscribe, sendProtocolMessage },
      fakeConnection(''),
    );
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('no-ops when the user has no stored memberships', async () => {
    const sql = createTestSql();
    ensurePersistenceSchema(sql);
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
        tagMembers: new Map(),
        subscribeConnectionAsServer: subscribe,
        sendProtocolMessage: () => {},
      },
      fakeConnection('u-42'),
    );
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('calls subscribeConnectionAsServer for every stored membership', async () => {
    const sql = createTestSql();
    ensurePersistenceSchema(sql);
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
        tagMembers: new Map(),
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
    ensurePersistenceSchema(sql);
    insertMembership(sql, { userId: 'u-42', channelName: 'team-eng', channelFamily: null });

    const subscribe = vi.fn(async () => {
      throw RejoinRejected({ message: 'not on the eng team' });
    });
    const sent: Array<{
      event: string;
      payload: Record<string, unknown>;
      wskit: Record<string, unknown>;
    }> = [];

    await autoRejoinIdentity(
      {
        sql,
        tagMembers: new Map(),
        subscribeConnectionAsServer: subscribe,
        sendProtocolMessage: (_c, { event, payload, wskit }: SendProtocolMessageOptions) =>
          sent.push({ event, payload, wskit }),
      },
      fakeConnection('u-42'),
    );

    expect(listMembershipsByUser(sql, 'u-42')).toHaveLength(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.event).toBe('__error__');
    expect(sent[0]!.wskit.channel).toBe('team-eng');
    expect(sent[0]!.payload.code).toBe('rejoin-rejected');
    expect((sent[0]!.payload.detail as { message: string }).message).toBe('not on the eng team');
  });

  it('propagates a config error and keeps the durable row', async () => {
    const sql = createTestSql();
    ensurePersistenceSchema(sql);
    insertMembership(sql, { userId: 'u-42', channelName: 'team-eng', channelFamily: null });

    const subscribe = vi.fn(async () => {
      throw new WSKitConfigError('misconfigured gate');
    });
    const sent: unknown[] = [];

    await expect(
      autoRejoinIdentity(
        {
          sql,
          tagMembers: new Map(),
          subscribeConnectionAsServer: subscribe,
          sendProtocolMessage: () => sent.push(1),
        },
        fakeConnection('u-42'),
      ),
    ).rejects.toBeInstanceOf(WSKitConfigError);

    expect(listMembershipsByUser(sql, 'u-42')).toHaveLength(1);
    expect(sent).toHaveLength(0);
  });

  it('propagates an internal/storage error and keeps the durable row', async () => {
    const sql = createTestSql();
    ensurePersistenceSchema(sql);
    insertMembership(sql, { userId: 'u-42', channelName: 'team-eng', channelFamily: null });

    const subscribe = vi.fn(async () => {
      throw new Error('transient storage failure');
    });
    const sent: unknown[] = [];

    await expect(
      autoRejoinIdentity(
        {
          sql,
          tagMembers: new Map(),
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
    ensurePersistenceSchema(sql);
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
        tagMembers: new Map(),
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

function tagConnection(userId: string): RuntimeConnection {
  return {
    id: 'c-1',
    userId,
    tags: { ephemeral: new Map(), persistent: new Map() },
  } as unknown as RuntimeConnection;
}

describe('restorePersistentTags', () => {
  it('deletes a stored tag whose value no longer matches its group schema', () => {
    const sql = createTestSql();
    ensurePersistenceSchema(sql);
    insertTag(sql, { userId: 'u-1', group: 'role', key: 'admin' });
    insertTag(sql, { userId: 'u-1', group: 'role', key: 'not-a-role!' });

    const connection = tagConnection('u-1');
    const errors: unknown[] = [];

    restorePersistentTags({
      sql,
      tagMembers: new Map(),
      connection,
      getSchema: () => v.picklist(['admin', 'editor']) as never,
      logger: { error: () => errors.push(1) },
    });

    const remaining = listTagsByUser(sql, 'u-1').map((t) => t.key);
    expect(remaining).toEqual(['admin']);
    expect(connection.tags.persistent.get('role')?.has('admin')).toBe(true);
    expect(errors).toHaveLength(1);
  });

  it('propagates a config error (async schema) and keeps the stored tag (#1)', () => {
    const sql = createTestSql();
    ensurePersistenceSchema(sql);
    insertTag(sql, { userId: 'u-1', group: 'role', key: 'admin' });
    const connection = tagConnection('u-1');
    // An async validator is a config error, not invalid stored data.
    const asyncSchema = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: () => Promise.resolve({ value: 'admin' }),
      },
    } as never;

    expect(() =>
      restorePersistentTags({
        sql,
        tagMembers: new Map(),
        connection,
        getSchema: () => asyncSchema,
        logger: { error: () => {} },
      }),
    ).toThrow(WSKitConfigError);

    // The valid row must survive a config error, not be silently deleted.
    expect(listTagsByUser(sql, 'u-1').map((t) => t.key)).toEqual(['admin']);
  });
});
