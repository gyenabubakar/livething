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
    payload: { source: 'client' },
    __wskit: { channel: channelName },
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
    expect(room.members.has('c42')).toBe(false);
    expect(room.members.size).toBe(0);
  });

  it('__memberOffline__ fires the callback but does not remove a member that is in the map', async () => {
    const { socket, ws } = build();
    const room = await subscribeChannel(socket, ws, 'general');

    // Add a member via __memberJoin__ first so the map is non-empty.
    ws.emit({
      event: '__memberJoin__',
      payload: { connectionId: 'c1', meta: {} },
      __wskit: { channel: 'general' },
    });
    expect(room.members.has('c1')).toBe(true);

    const onOffline = vi.fn();
    room.onMemberOffline(onOffline);

    ws.emit({
      event: '__memberOffline__',
      payload: { connectionId: 'c1' },
      __wskit: { channel: 'general' },
    });

    expect(onOffline).toHaveBeenCalledWith('c1');
    // Member is still in the map — offline != leave.
    expect(room.members.has('c1')).toBe(true);
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
    expect(room.members.has('c1')).toBe(true);
    expect(room.members.size).toBe(1);

    // Second sync with a completely different roster.
    ws.emit({
      event: '__memberSync__',
      payload: { members: [{ connectionId: 'c2', meta: { name: 'Bob' } }] },
      __wskit: { channel: 'general' },
    });

    // c1 was in the first sync but not the second — it must be gone.
    expect(room.members.has('c1')).toBe(false);
    // c2 is the only member now.
    expect(room.members.has('c2')).toBe(true);
    expect(room.members.size).toBe(1);
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

    // Only c2 triggers join and online events.
    expect(onJoin).toHaveBeenCalledOnce();
    expect(onJoin).toHaveBeenCalledWith('c2', { meta: { role: 'admin' } });
    expect(onOnline).toHaveBeenCalledOnce();
    expect(onOnline).toHaveBeenCalledWith('c2', { meta: { role: 'admin' } });
  });
});

describe('top-level channel and scoped channel with same name are independent', () => {
  it('a top-level channel(name) and a scoped channel(scope, name) sharing the same name have distinct state and members', async () => {
    const { socket, ws } = build();

    // Subscribe both channels: top-level 'general' and scoped 'rooms'/'general'.
    const topLevel = socket.channel('general');
    const topPromise = topLevel.subscribe();
    ws.emit({
      event: '__subscribeOk__',
      payload: { source: 'client' },
      __wskit: { channel: 'general' },
    });
    await topPromise;

    const scoped = socket.channel('rooms', 'general');
    const scopedPromise = scoped.subscribe();
    ws.emit({
      event: '__subscribeOk__',
      payload: { source: 'client' },
      __wskit: { channel: 'general', channelScope: 'rooms' },
    });
    await scopedPromise;

    // Add a member only to the scoped channel.
    ws.emit({
      event: '__memberJoin__',
      payload: { connectionId: 'c1' },
      __wskit: { channel: 'general', channelScope: 'rooms' },
    });

    // The scoped channel has the member; the top-level channel does not.
    expect(scoped.members.has('c1')).toBe(true);
    expect(topLevel.members.has('c1')).toBe(false);
  });

  it('events routed to the scoped channel do not fire handlers on the top-level channel', async () => {
    const { socket, ws } = build();

    const topLevel = socket.channel('general');
    const topPromise = topLevel.subscribe();
    ws.emit({
      event: '__subscribeOk__',
      payload: { source: 'client' },
      __wskit: { channel: 'general' },
    });
    await topPromise;

    const scoped = socket.channel('rooms', 'general');
    const scopedPromise = scoped.subscribe();
    ws.emit({
      event: '__subscribeOk__',
      payload: { source: 'client' },
      __wskit: { channel: 'general', channelScope: 'rooms' },
    });
    await scopedPromise;

    const topHandler = vi.fn();
    const scopedHandler = vi.fn();
    topLevel.on('message', topHandler);
    scoped.on('message', scopedHandler);

    ws.emit({
      event: 'message',
      payload: { text: 'scoped only' },
      __wskit: { channel: 'general', channelScope: 'rooms' },
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
