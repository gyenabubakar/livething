import {
  addConnectionTag,
  removeConnectionFromTagIndex,
  removeConnectionTag,
} from '~/_engine/runtime/tag-index.ts';
import { buildGroupHandle } from '~/tags/runtime.ts';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';
import type { TagsRuntime } from '~/tags/runtime.ts';

function createConnection(id: string): RuntimeConnection {
  return {
    id,
    userId: id,
    wsKey: Symbol(id),
    descriptor: {
      send() {},
      close() {},
      bufferedAmount() {
        return 0;
      },
      identity: id,
    },
    meta: {},
    tags: { ephemeral: new Map(), persistent: new Map() },
    channelMemberships: new Map(),
    latency: null,
    quality: 'good',
  };
}

function createRuntime(
  tagMembers: Map<string, Set<RuntimeConnection>>,
  sent: string[],
): TagsRuntime {
  return {
    tagMembers,
    isTagGroupDeclared: () => true,
    getTagGroupSchema: () => undefined,
    toConnectionInfo: (connection: RuntimeConnection) => ({ id: connection.id }),
    sendThroughPipeline: (connection: RuntimeConnection) => {
      sent.push(connection.id);
    },
    persistAttachment: () => {},
    getStorage: () => {
      throw new Error('unused');
    },
  } as unknown as TagsRuntime;
}

describe('tag member index', () => {
  it('tag-ref send reaches only connections holding the exact tag', () => {
    const tagMembers = new Map<string, Set<RuntimeConnection>>();
    const sent: string[] = [];
    const eng = createConnection('eng');
    const sales = createConnection('sales');
    addConnectionTag(tagMembers, eng, { kind: 'ephemeral', group: 'team', key: 'eng' });
    addConnectionTag(tagMembers, sales, { kind: 'ephemeral', group: 'team', key: 'sales' });

    const runtime = createRuntime(tagMembers, sent);
    buildGroupHandle(runtime, eng, { kind: 'ephemeral', group: 'team' }).ref('eng').send('evt', {});

    expect(sent).toEqual(['eng']);
  });

  it('add("") is a no-op so an empty key never creates a phantom bucket', () => {
    const tagMembers = new Map<string, Set<RuntimeConnection>>();
    const sent: string[] = [];
    const conn = createConnection('c1');
    const runtime = createRuntime(tagMembers, sent);
    const group = buildGroupHandle(runtime, conn, { kind: 'ephemeral', group: 'team' });

    group.add('');
    group.remove('');

    expect(group.count()).toBe(0);
    expect(tagMembers.size).toBe(0);
    group.ref('').send('evt', {});
    expect(sent).toEqual([]);
  });

  it('group send reaches every connection with any key in the group', () => {
    const tagMembers = new Map<string, Set<RuntimeConnection>>();
    const sent: string[] = [];
    const a = createConnection('a');
    const b = createConnection('b');
    addConnectionTag(tagMembers, a, { kind: 'ephemeral', group: 'team', key: 'eng' });
    addConnectionTag(tagMembers, b, { kind: 'ephemeral', group: 'team', key: 'sales' });

    buildGroupHandle(createRuntime(tagMembers, sent), a, { kind: 'ephemeral', group: 'team' }).send(
      'evt',
      {},
    );

    expect(sent.sort()).toEqual(['a', 'b']);
  });

  it('removing one of two keys keeps the connection in the group index', () => {
    const tagMembers = new Map<string, Set<RuntimeConnection>>();
    const sent: string[] = [];
    const conn = createConnection('c1');
    addConnectionTag(tagMembers, conn, { kind: 'ephemeral', group: 'team', key: 'eng' });
    addConnectionTag(tagMembers, conn, { kind: 'ephemeral', group: 'team', key: 'lead' });

    removeConnectionTag(tagMembers, conn, { kind: 'ephemeral', group: 'team', key: 'eng' });

    const runtime = createRuntime(tagMembers, sent);
    buildGroupHandle(runtime, conn, { kind: 'ephemeral', group: 'team' }).send('evt', {});
    expect(sent).toEqual(['c1']);
    expect(
      buildGroupHandle(runtime, conn, { kind: 'ephemeral', group: 'team' }).ref('eng').count(),
    ).toBe(0);
  });

  it('removing the last key drops every index entry for the group', () => {
    const tagMembers = new Map<string, Set<RuntimeConnection>>();
    const conn = createConnection('c1');
    addConnectionTag(tagMembers, conn, { kind: 'ephemeral', group: 'team', key: 'eng' });

    removeConnectionTag(tagMembers, conn, { kind: 'ephemeral', group: 'team', key: 'eng' });

    expect(tagMembers.size).toBe(0);
  });

  it('removeConnectionFromTagIndex drops a closing connection from every entry', () => {
    const tagMembers = new Map<string, Set<RuntimeConnection>>();
    const conn = createConnection('c1');
    addConnectionTag(tagMembers, conn, { kind: 'ephemeral', group: 'team', key: 'eng' });
    addConnectionTag(tagMembers, conn, { kind: 'persistent', group: 'role', key: 'admin' });

    removeConnectionFromTagIndex(tagMembers, conn);

    expect(tagMembers.size).toBe(0);
  });
});

describe('group handle reflection methods', () => {
  it('count returns the distinct connection count for the group', () => {
    const tagMembers = new Map<string, Set<RuntimeConnection>>();
    const sent: string[] = [];
    const a = createConnection('a');
    const b = createConnection('b');
    addConnectionTag(tagMembers, a, { kind: 'ephemeral', group: 'team', key: 'eng' });
    addConnectionTag(tagMembers, a, { kind: 'ephemeral', group: 'team', key: 'lead' });
    addConnectionTag(tagMembers, b, { kind: 'ephemeral', group: 'team', key: 'sales' });

    const runtime = createRuntime(tagMembers, sent);
    expect(buildGroupHandle(runtime, a, { kind: 'ephemeral', group: 'team' }).count()).toBe(2);
  });

  it('count is zero for a group no connection holds', () => {
    const tagMembers = new Map<string, Set<RuntimeConnection>>();
    const conn = createConnection('a');
    const runtime = createRuntime(tagMembers, []);
    expect(buildGroupHandle(runtime, conn, { kind: 'ephemeral', group: 'team' }).count()).toBe(0);
  });

  it('keys lists every active key under the group across all connections', () => {
    const tagMembers = new Map<string, Set<RuntimeConnection>>();
    const a = createConnection('a');
    const b = createConnection('b');
    addConnectionTag(tagMembers, a, { kind: 'ephemeral', group: 'team', key: 'eng' });
    addConnectionTag(tagMembers, a, { kind: 'ephemeral', group: 'team', key: 'lead' });
    addConnectionTag(tagMembers, b, { kind: 'ephemeral', group: 'team', key: 'eng' });

    const runtime = createRuntime(tagMembers, []);
    const keys = buildGroupHandle(runtime, a, { kind: 'ephemeral', group: 'team' }).keys();
    expect([...keys].sort()).toEqual(['eng', 'lead']);
  });

  it('keys is empty for a group no connection holds', () => {
    const tagMembers = new Map<string, Set<RuntimeConnection>>();
    const conn = createConnection('a');
    const runtime = createRuntime(tagMembers, []);
    expect(buildGroupHandle(runtime, conn, { kind: 'ephemeral', group: 'team' }).keys()).toEqual(
      [],
    );
  });

  it('has reflects only the calling connection membership under the group', () => {
    const tagMembers = new Map<string, Set<RuntimeConnection>>();
    const a = createConnection('a');
    const b = createConnection('b');
    addConnectionTag(tagMembers, a, { kind: 'ephemeral', group: 'team', key: 'eng' });
    addConnectionTag(tagMembers, b, { kind: 'ephemeral', group: 'team', key: 'sales' });

    const runtime = createRuntime(tagMembers, []);
    const aHandle = buildGroupHandle(runtime, a, { kind: 'ephemeral', group: 'team' });
    expect(aHandle.has('eng')).toBe(true);
    expect(aHandle.has('sales')).toBe(false);
    expect(aHandle.has('missing')).toBe(false);
  });

  it('connections returns a snapshot for every connection in the group', () => {
    const tagMembers = new Map<string, Set<RuntimeConnection>>();
    const a = createConnection('a');
    const b = createConnection('b');
    addConnectionTag(tagMembers, a, { kind: 'ephemeral', group: 'team', key: 'eng' });
    addConnectionTag(tagMembers, b, { kind: 'ephemeral', group: 'team', key: 'sales' });

    const runtime = createRuntime(tagMembers, []);
    const snaps = buildGroupHandle(runtime, a, { kind: 'ephemeral', group: 'team' }).connections();
    expect(snaps.map((s) => s.id).sort()).toEqual(['a', 'b']);
  });

  it('connections is empty for a group no connection holds', () => {
    const tagMembers = new Map<string, Set<RuntimeConnection>>();
    const conn = createConnection('a');
    const runtime = createRuntime(tagMembers, []);
    expect(
      buildGroupHandle(runtime, conn, { kind: 'ephemeral', group: 'team' }).connections(),
    ).toEqual([]);
  });
});

function createPersistentRuntime(
  tagMembers: Map<string, Set<RuntimeConnection>>,
  exec: (query: string, ...params: unknown[]) => unknown,
): TagsRuntime {
  return {
    tagMembers,
    isTagGroupDeclared: () => true,
    getTagGroupSchema: () => undefined,
    toConnectionInfo: (connection: RuntimeConnection) => ({ id: connection.id }),
    sendThroughPipeline: () => {},
    persistAttachment: () => {},
    getStorage: () => ({ sql: { exec } }),
  } as unknown as TagsRuntime;
}

describe('persistent tag durability ordering', () => {
  it('add writes the durable row and then updates the live index', () => {
    const tagMembers = new Map<string, Set<RuntimeConnection>>();
    const conn = createConnection('u1');
    const calls: unknown[][] = [];
    const runtime = createPersistentRuntime(tagMembers, (_query, ...params) => {
      calls.push(params);
    });

    buildGroupHandle(runtime, conn, { kind: 'persistent', group: 'role' }).add('admin');

    expect(calls).toHaveLength(1);
    expect(conn.tags.persistent.get('role')?.has('admin')).toBe(true);
  });

  it('add: a failed durable write leaves no live tag', () => {
    // The durable write runs first, so when it throws the live index must be
    // untouched — otherwise the connection looks tagged with nothing saved.
    const tagMembers = new Map<string, Set<RuntimeConnection>>();
    const conn = createConnection('u1');
    const runtime = createPersistentRuntime(tagMembers, () => {
      throw new Error('sql down');
    });

    expect(() =>
      buildGroupHandle(runtime, conn, { kind: 'persistent', group: 'role' }).add('admin'),
    ).toThrow('sql down');

    expect(conn.tags.persistent.get('role')?.has('admin') ?? false).toBe(false);
    expect(tagMembers.size).toBe(0);
  });

  it('remove: a failed durable delete keeps the live tag', () => {
    const tagMembers = new Map<string, Set<RuntimeConnection>>();
    const conn = createConnection('u1');
    addConnectionTag(tagMembers, conn, { kind: 'persistent', group: 'role', key: 'admin' });
    const runtime = createPersistentRuntime(tagMembers, () => {
      throw new Error('sql down');
    });

    expect(() =>
      buildGroupHandle(runtime, conn, { kind: 'persistent', group: 'role' }).remove('admin'),
    ).toThrow('sql down');

    expect(conn.tags.persistent.get('role')?.has('admin')).toBe(true);
  });
});

function runtimeWithSchema(schema: unknown): TagsRuntime {
  return {
    tagMembers: new Map(),
    isTagGroupDeclared: () => true,
    getTagGroupSchema: () => schema,
    toConnectionInfo: (connection: RuntimeConnection) => ({ id: connection.id }),
    sendThroughPipeline: () => {},
    persistAttachment: () => {},
    getStorage: () => ({ sql: { exec: () => {} } }),
  } as unknown as TagsRuntime;
}

describe('tag value validation', () => {
  it('accepts a value that matches the group schema', () => {
    const conn = createConnection('u1');
    const runtime = runtimeWithSchema(v.picklist(['admin', 'viewer']));
    buildGroupHandle(runtime, conn, { kind: 'ephemeral', group: 'role' }).add('viewer');
    expect(conn.tags.ephemeral.get('role')?.has('viewer')).toBe(true);
  });

  it('rejects a value that fails the group schema, before any state change', () => {
    const conn = createConnection('u1');
    const runtime = runtimeWithSchema(v.picklist(['admin', 'viewer']));
    expect(() =>
      buildGroupHandle(runtime, conn, { kind: 'ephemeral', group: 'role' }).add('nope'),
    ).toThrow();
    expect(conn.tags.ephemeral.get('role')?.has('nope') ?? false).toBe(false);
  });

  it('skips validation when the group has no schema (t<>() marker)', () => {
    const conn = createConnection('u1');
    const runtime = runtimeWithSchema(undefined);
    buildGroupHandle(runtime, conn, { kind: 'ephemeral', group: 'free' }).add('anything');
    expect(conn.tags.ephemeral.get('free')?.has('anything')).toBe(true);
  });
});
