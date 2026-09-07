import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { channels } from '~/primitives/channels/index.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface C {
  channels: {
    general: {
      incoming: { message: { text: string } };
      outgoing: { 'send-message': { text: string } };
    };
    rooms: {
      addressing: 'dynamic';
      incoming: { message: { text: string } };
      outgoing: { 'send-message': { text: string } };
    };
  };
}

function build() {
  const socket = client<C>()(connect('wss://test'), channels());
  socket.connect();
  const ws = MockWebSocket.last();
  ws.open();

  return { socket, ws };
}

type BuiltSocket = ReturnType<typeof build>['socket'];

async function subscribeChannel(socket: BuiltSocket, ws: MockWebSocket, channelName: 'general') {
  const room = socket.channel(channelName);
  const p = room.subscribe();
  ws.emit({
    event: '__subscribeOk__',
    payload: {},
    __wskit: { source: 'client', channel: channelName },
  });
  await p;

  return room;
}

let restore: () => void;
beforeEach(() => {
  restore = installMockWebSocket();
});
afterEach(() => {
  restore();
});

describe('__memberOnline__ and __memberOffline__ frames', () => {
  it('fires onMemberOnline when the server sends __memberOnline__', async () => {
    const { socket, ws } = build();
    const room = await subscribeChannel(socket, ws, 'general');

    const onOnline = vi.fn();
    room.onMemberOnline(onOnline);

    ws.emit({
      event: '__memberOnline__',
      payload: { connectionId: 'c1', meta: { name: 'Ada' } },
      __wskit: { channel: 'general' },
    });

    expect(onOnline).toHaveBeenCalledOnce();
    expect(onOnline).toHaveBeenCalledWith('c1', { meta: { name: 'Ada' } });
  });

  it('fires onMemberOffline when the server sends __memberOffline__', async () => {
    const { socket, ws } = build();
    const room = await subscribeChannel(socket, ws, 'general');

    const onOffline = vi.fn();
    room.onMemberOffline(onOffline);

    ws.emit({
      event: '__memberOffline__',
      payload: { connectionId: 'c1' },
      __wskit: { channel: 'general' },
    });

    expect(onOffline).toHaveBeenCalledOnce();
    expect(onOffline).toHaveBeenCalledWith('c1');
  });
});

describe('__memberOnline__/__memberOffline__ do not mutate the members map', () => {
  it('__memberOnline__ fires the callback but does not add the member to the map', async () => {
    const { socket, ws } = build();
    const room = await subscribeChannel(socket, ws, 'general');

    const onOnline = vi.fn();
    room.onMemberOnline(onOnline);

    ws.emit({
      event: '__memberOnline__',
      payload: { connectionId: 'c42', meta: { name: 'Bob' } },
      __wskit: { channel: 'general' },
    });

    expect(onOnline).toHaveBeenCalledWith('c42', { meta: { name: 'Bob' } });
    expect(room.members.get().has('c42')).toBe(false);
    expect(room.members.get().size).toBe(0);
  });

  it('__memberOffline__ fires the callback but does not remove a member that is in the map', async () => {
    const { socket, ws } = build();
    const room = await subscribeChannel(socket, ws, 'general');

    ws.emit({
      event: '__memberJoin__',
      payload: { connectionId: 'c1', meta: {} },
      __wskit: { channel: 'general' },
    });
    expect(room.members.get().has('c1')).toBe(true);

    const onOffline = vi.fn();
    room.onMemberOffline(onOffline);

    ws.emit({
      event: '__memberOffline__',
      payload: { connectionId: 'c1' },
      __wskit: { channel: 'general' },
    });

    expect(onOffline).toHaveBeenCalledWith('c1');
    expect(room.members.get().has('c1')).toBe(true);
  });
});

describe('channel.members store — snapshot identity', () => {
  it('keeps the same map reference across an online/offline that does not change the roster', async () => {
    const { socket, ws } = build();
    const room = await subscribeChannel(socket, ws, 'general');

    ws.emit({
      event: '__memberJoin__',
      payload: { connectionId: 'c1', meta: {} },
      __wskit: { channel: 'general' },
    });
    const snapshot = room.members.get();

    ws.emit({
      event: '__memberOnline__',
      payload: { connectionId: 'c42', meta: { name: 'Bob' } },
      __wskit: { channel: 'general' },
    });
    ws.emit({
      event: '__memberOffline__',
      payload: { connectionId: 'c1' },
      __wskit: { channel: 'general' },
    });

    expect(room.members.get()).toBe(snapshot);
  });

  it('publishes a fresh snapshot to subscribers on join and on leave', async () => {
    const { socket, ws } = build();
    const room = await subscribeChannel(socket, ws, 'general');

    const snapshots: ReadonlyMap<string, { meta: Record<string, unknown> }>[] = [];
    room.members.subscribe((members) => snapshots.push(members));

    ws.emit({
      event: '__memberJoin__',
      payload: { connectionId: 'c1', meta: {} },
      __wskit: { channel: 'general' },
    });
    ws.emit({
      event: '__memberLeave__',
      payload: { connectionId: 'c1' },
      __wskit: { channel: 'general' },
    });

    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]).not.toBe(snapshots[1]);
    expect(snapshots[0]?.has('c1')).toBe(true);
    expect(snapshots[1]?.has('c1')).toBe(false);
  });
});

describe('__memberSync__ replaces, not merges, the member roster', () => {
  it('a second __memberSync__ drops stale members and reflects only the new list', async () => {
    const { socket, ws } = build();
    const room = await subscribeChannel(socket, ws, 'general');

    ws.emit({
      event: '__memberSync__',
      payload: { members: [{ connectionId: 'c1', meta: { name: 'Ada' } }] },
      __wskit: { channel: 'general' },
    });
    expect(room.members.get().has('c1')).toBe(true);
    expect(room.members.get().size).toBe(1);

    ws.emit({
      event: '__memberSync__',
      payload: { members: [{ connectionId: 'c2', meta: { name: 'Bob' } }] },
      __wskit: { channel: 'general' },
    });

    expect(room.members.get().has('c1')).toBe(false);
    expect(room.members.get().has('c2')).toBe(true);
    expect(room.members.get().size).toBe(1);
  });

  it('a second __memberSync__ fires join+online for new members, not for dropped ones', async () => {
    const { socket, ws } = build();
    const room = await subscribeChannel(socket, ws, 'general');

    ws.emit({
      event: '__memberSync__',
      payload: { members: [{ connectionId: 'c1', meta: {} }] },
      __wskit: { channel: 'general' },
    });

    const onJoin = vi.fn();
    const onOnline = vi.fn();
    room.onMemberJoin(onJoin);
    room.onMemberOnline(onOnline);

    ws.emit({
      event: '__memberSync__',
      payload: { members: [{ connectionId: 'c2', meta: { role: 'admin' } }] },
      __wskit: { channel: 'general' },
    });

    expect(onJoin).toHaveBeenCalledOnce();
    expect(onJoin).toHaveBeenCalledWith('c2', { meta: { role: 'admin' } });
    expect(onOnline).toHaveBeenCalledOnce();
    expect(onOnline).toHaveBeenCalledWith('c2', { meta: { role: 'admin' } });
  });
});

describe('top-level channel and scoped channel with same name are independent', () => {
  it('a top-level channel(name) and a scoped channel(scope, name) sharing the same name have distinct state and members', async () => {
    const { socket, ws } = build();

    const topLevel = socket.channel('general');
    const topPromise = topLevel.subscribe();
    ws.emit({
      event: '__subscribeOk__',
      payload: {},
      __wskit: { source: 'client', channel: 'general' },
    });
    await topPromise;

    const scoped = socket.channel('rooms', 'general');
    const scopedPromise = scoped.subscribe();
    ws.emit({
      event: '__subscribeOk__',
      payload: {},
      __wskit: { source: 'client', channel: 'general', channelFamily: 'rooms' },
    });
    await scopedPromise;

    ws.emit({
      event: '__memberJoin__',
      payload: { connectionId: 'c1' },
      __wskit: { channel: 'general', channelFamily: 'rooms' },
    });

    expect(scoped.members.get().has('c1')).toBe(true);
    expect(topLevel.members.get().has('c1')).toBe(false);
  });

  it('events routed to the scoped channel do not fire handlers on the top-level channel', async () => {
    const { socket, ws } = build();

    const topLevel = socket.channel('general');
    const topPromise = topLevel.subscribe();
    ws.emit({
      event: '__subscribeOk__',
      payload: {},
      __wskit: { source: 'client', channel: 'general' },
    });
    await topPromise;

    const scoped = socket.channel('rooms', 'general');
    const scopedPromise = scoped.subscribe();
    ws.emit({
      event: '__subscribeOk__',
      payload: {},
      __wskit: { source: 'client', channel: 'general', channelFamily: 'rooms' },
    });
    await scopedPromise;

    const topHandler = vi.fn();
    const scopedHandler = vi.fn();
    topLevel.on('message', topHandler);
    scoped.on('message', scopedHandler);

    ws.emit({
      event: 'message',
      payload: { text: 'scoped only' },
      __wskit: { channel: 'general', channelFamily: 'rooms' },
    });

    expect(scopedHandler).toHaveBeenCalledWith({ text: 'scoped only' });
    expect(topHandler).not.toHaveBeenCalled();
  });

  it('top-level channel(name) and scoped channel(scope,name) are not the same object', () => {
    const { socket } = build();
    const topLevel = socket.channel('general');
    const scoped = socket.channel('rooms', 'general');
    expect(topLevel).not.toBe(scoped);
  });
});

describe('presence frames are ignored while a leave is pending', () => {
  async function subscribedWithPendingLeave() {
    const { socket, ws } = build();
    const room = await subscribeChannel(socket, ws, 'general');
    ws.emit({
      event: '__memberSync__',
      payload: { members: [{ connectionId: 'c1', meta: { name: 'Ada' } }] },
      __wskit: { channel: 'general' },
    });
    expect(room.members.get().size).toBe(1);
    room.unsubscribe();

    return { socket, ws, room };
  }

  it('ignores a __memberSync__ that would repopulate a roster of a leaving channel', async () => {
    const { ws, room } = await subscribedWithPendingLeave();
    ws.emit({
      event: '__memberSync__',
      payload: { members: [{ connectionId: 'c2', meta: {} }] },
      __wskit: { channel: 'general' },
    });
    expect(room.members.get().size).toBe(0);
  });

  it('ignores __memberJoin__/__memberOnline__ while a leave is pending', async () => {
    const { ws, room } = await subscribedWithPendingLeave();
    const onJoin = vi.fn();
    const onOnline = vi.fn();
    room.onMemberJoin(onJoin);
    room.onMemberOnline(onOnline);

    ws.emit({
      event: '__memberJoin__',
      payload: { connectionId: 'c3', meta: {} },
      __wskit: { channel: 'general' },
    });
    ws.emit({
      event: '__memberOnline__',
      payload: { connectionId: 'c3', meta: {} },
      __wskit: { channel: 'general' },
    });
    expect(onJoin).not.toHaveBeenCalled();
    expect(onOnline).not.toHaveBeenCalled();
    expect(room.members.get().size).toBe(0);
  });
});

describe('resyncMembers() fire-and-forget request', () => {
  it('sends a client-source __memberSync__ when subscribed', async () => {
    const { socket, ws } = build();
    const room = await subscribeChannel(socket, ws, 'general');
    room.resyncMembers();
    const frame = ws
      .sentFrames()
      .filter((f) => f.event === '__memberSync__')
      .at(-1);
    expect(frame).toBeDefined();

    expect(frame?.__wskit?.channel).toBe('general');
    expect(frame?.__wskit?.source).toBe('client');
  });

  it('is a no-op (sends nothing) when the channel is not active', () => {
    const { socket, ws } = build();
    const room = socket.channel('general');
    room.resyncMembers();
    expect(ws.sentFrames().some((f) => f.event === '__memberSync__')).toBe(false);
  });
});

describe('presence frames after the channel has been left', () => {
  async function leftChannel() {
    const { socket, ws } = build();
    const room = await subscribeChannel(socket, ws, 'general');
    room.unsubscribe();
    const leave = ws.sentFrames().find((f) => f.event === '__unsubscribe__');
    ws.emit({
      event: '__unsubscribeOk__',
      payload: {},
      __wskit: { channel: 'general', unsubscribeId: leave?.__wskit?.unsubscribeId },
    });

    return { room, ws };
  }

  it('ignores a __memberSync__ that lands after __unsubscribeOk__', async () => {
    const { room, ws } = await leftChannel();
    const onJoin = vi.fn();
    room.onMemberJoin(onJoin);

    ws.emit({
      event: '__memberSync__',
      payload: { members: [{ connectionId: 'c1', meta: { name: 'Ada' } }] },
      __wskit: { channel: 'general' },
    });

    expect(onJoin).not.toHaveBeenCalled();
    expect(room.members.get().size).toBe(0);
  });

  it('ignores a __memberJoin__ that lands after __unsubscribeOk__', async () => {
    const { room, ws } = await leftChannel();
    const onJoin = vi.fn();
    room.onMemberJoin(onJoin);

    ws.emit({
      event: '__memberJoin__',
      payload: { connectionId: 'c1', meta: { name: 'Ada' } },
      __wskit: { channel: 'general' },
    });

    expect(onJoin).not.toHaveBeenCalled();
    expect(room.members.get().size).toBe(0);
  });
});
