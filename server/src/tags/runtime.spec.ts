import {
  addConnectionTag,
  buildGroupHandle,
  removeConnectionFromTagIndex,
  removeConnectionTag,
} from '~/tags/runtime.ts';
import { describe, expect, it } from 'vitest';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';
import type { TagsRuntime } from '~/tags/runtime.ts';

function createConnection(id: string): RuntimeConnection {
  return {
    id,
    identity: id,
    wsKey: Symbol(id),
    descriptor: {
      send() {},
      sendBinary() {},
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
    toConnectionInfo: (connection: RuntimeConnection) => ({ id: connection.id }),
    sendThroughPipeline: (connection: RuntimeConnection) => {
      sent.push(connection.id);
    },
    persistAttachment: () => {},
    persistenceEnabled: false,
    requireStorage: () => {
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
    addConnectionTag(tagMembers, eng, 'ephemeral', 'team', 'eng');
    addConnectionTag(tagMembers, sales, 'ephemeral', 'team', 'sales');

    const runtime = createRuntime(tagMembers, sent);
    buildGroupHandle(runtime, eng, 'ephemeral', 'team').ref('eng').send('evt', {});

    expect(sent).toEqual(['eng']);
  });

  it('group send reaches every connection with any key in the group', () => {
    const tagMembers = new Map<string, Set<RuntimeConnection>>();
    const sent: string[] = [];
    const a = createConnection('a');
    const b = createConnection('b');
    addConnectionTag(tagMembers, a, 'ephemeral', 'team', 'eng');
    addConnectionTag(tagMembers, b, 'ephemeral', 'team', 'sales');

    buildGroupHandle(createRuntime(tagMembers, sent), a, 'ephemeral', 'team').send('evt', {});

    expect(sent.sort()).toEqual(['a', 'b']);
  });

  it('removing one of two keys keeps the connection in the group index', () => {
    const tagMembers = new Map<string, Set<RuntimeConnection>>();
    const sent: string[] = [];
    const conn = createConnection('c1');
    addConnectionTag(tagMembers, conn, 'ephemeral', 'team', 'eng');
    addConnectionTag(tagMembers, conn, 'ephemeral', 'team', 'lead');

    removeConnectionTag(tagMembers, conn, 'ephemeral', 'team', 'eng');

    const runtime = createRuntime(tagMembers, sent);
    buildGroupHandle(runtime, conn, 'ephemeral', 'team').send('evt', {});
    expect(sent).toEqual(['c1']);
    expect(buildGroupHandle(runtime, conn, 'ephemeral', 'team').ref('eng').count()).toBe(0);
  });

  it('removing the last key drops every index entry for the group', () => {
    const tagMembers = new Map<string, Set<RuntimeConnection>>();
    const conn = createConnection('c1');
    addConnectionTag(tagMembers, conn, 'ephemeral', 'team', 'eng');

    removeConnectionTag(tagMembers, conn, 'ephemeral', 'team', 'eng');

    expect(tagMembers.size).toBe(0);
  });

  it('removeConnectionFromTagIndex drops a closing connection from every entry', () => {
    const tagMembers = new Map<string, Set<RuntimeConnection>>();
    const conn = createConnection('c1');
    addConnectionTag(tagMembers, conn, 'ephemeral', 'team', 'eng');
    addConnectionTag(tagMembers, conn, 'persistent', 'role', 'admin');

    removeConnectionFromTagIndex(tagMembers, conn);

    expect(tagMembers.size).toBe(0);
  });
});
