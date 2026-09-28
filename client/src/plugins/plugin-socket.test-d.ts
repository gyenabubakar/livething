// Type-only checks for the plugin socket. tsc checks these; vitest never runs them.
import { expectTypeOf } from 'vitest';
import type { LiveThingError } from '@livething/core';
import type { PluginSocket } from '~/plugins/plugin-socket.ts';

interface ChatContract {
  incoming: { message: { id: string; text: string } };
  outgoing: { typing: { on: boolean } };
  clientRequests: { 'send-message': { payload: { text: string }; response: { id: string } } };
  channels: {
    room: { incoming: { reaction: { emoji: string } } }; // static channel
    thread: { addressing: 'dynamic'; incoming: { post: { text: string } } }; // dynamic family
  };
  streams: { feed: { payload: { from: number }; chunk: { row: number } } };
  serverRequests: { ping: { payload: { at: number }; response: { pong: boolean } } };
  errors: { 'room-full': { limit: number } };
}

type ChatSocket = PluginSocket<ChatContract>;
expectTypeOf<ChatSocket>().not.toHaveProperty('onError');

// Typed receive, scoped to the plugin's own events.
expectTypeOf<ChatSocket['on']>().toBeFunction();
expectTypeOf<Parameters<ChatSocket['on']>[0]>().toEqualTypeOf<'message'>();
expectTypeOf<Parameters<Parameters<ChatSocket['on']>[1]>[0]>().toEqualTypeOf<{
  id: string;
  text: string;
}>();

// Typed fire-and-forget send.
expectTypeOf<Parameters<ChatSocket['send']>[0]>().toEqualTypeOf<'typing'>();
expectTypeOf<Parameters<ChatSocket['send']>[1]>().toEqualTypeOf<{ on: boolean }>();

// Typed request/response.
expectTypeOf<ChatSocket['request']>().toBeFunction();
expectTypeOf<ReturnType<ChatSocket['request']>>().toEqualTypeOf<Promise<{ id: string }>>();

// Typed channel — all three forms, like the top-level socket.
declare const chat: ChatSocket;
// A static channel by name.
expectTypeOf(chat.channel('room')).toHaveProperty('subscribe');
expectTypeOf(chat.channel('room')).toHaveProperty('on');
// A dynamic-family member: channel(family, name).
expectTypeOf(chat.channel('thread', 'thread:1')).toHaveProperty('subscribe');
// The whole family handle, for watching every member.
expectTypeOf(chat.channel.family('thread')).toHaveProperty('list');
expectTypeOf(chat.channel.family('thread')).toHaveProperty('onSubscribed');
// @ts-expect-error — a dynamic family needs a member name, not the one-arg form
chat.channel('thread');
// @ts-expect-error — a static channel takes no member name
chat.channel('room', 'x');
// @ts-expect-error — family() only addresses a dynamic family, not a static channel
chat.channel.family('room');

// Typed streams.
expectTypeOf<ChatSocket['stream']>().toBeFunction();
expectTypeOf<Parameters<ChatSocket['stream']>[0]>().toEqualTypeOf<'feed'>();
expectTypeOf<ChatSocket['onStream']>().toBeFunction();
expectTypeOf<ChatSocket['resumeStream']>().toBeFunction();

// Typed server→client request handler.
expectTypeOf<ChatSocket['onRequest']>().toBeFunction();
expectTypeOf<Parameters<ChatSocket['onRequest']>[0]>().toEqualTypeOf<'ping'>();

chat.onServerError((error) => {
  expectTypeOf(error).toEqualTypeOf<LiveThingError<string, unknown>>();
});

chat.onServerError('room-full', (error) => {
  expectTypeOf(error).toEqualTypeOf<LiveThingError<'room-full', { limit: number }>>();
});

// @ts-expect-error — code-specific subscriptions only accept declared plugin error codes
chat.onServerError('not-declared', () => {});

// The always-present message handlers and tools are there too.
expectTypeOf<ChatSocket['onIncoming']>().toBeFunction();
expectTypeOf<ChatSocket['onOutgoing']>().toBeFunction();
expectTypeOf<ChatSocket['onOpen']>().toBeFunction();
expectTypeOf<ChatSocket['onClose']>().toBeFunction();
expectTypeOf<ChatSocket['generateId']>().toBeFunction();
expectTypeOf<ChatSocket['hasPrimitive']>().toBeFunction();
// The connection state is a reactive store — read now or subscribe to changes.
expectTypeOf<ChatSocket['state']['get']>().toBeFunction();
expectTypeOf<ChatSocket['state']['subscribe']>().toBeFunction();

// A plugin with no contract (hook-only) has the message handlers and tools but none of the
// typed verbs.
type PlainSocket = PluginSocket;
expectTypeOf<PlainSocket['onIncoming']>().toBeFunction();
expectTypeOf<PlainSocket['generateId']>().toBeFunction();
expectTypeOf<PlainSocket>().not.toHaveProperty('on');
expectTypeOf<PlainSocket>().not.toHaveProperty('send');
expectTypeOf<PlainSocket>().not.toHaveProperty('request');
expectTypeOf<PlainSocket>().not.toHaveProperty('channel');
expectTypeOf<PlainSocket>().not.toHaveProperty('stream');
expectTypeOf<PlainSocket>().not.toHaveProperty('onRequest');

// A plugin that only receives (incoming, no clientRequests/channels/streams) has `on`
// but none of the other verbs.
type ReceiveOnly = PluginSocket<{ incoming: { tick: { n: number } } }>;
expectTypeOf<ReceiveOnly['on']>().toBeFunction();
expectTypeOf<ReceiveOnly>().not.toHaveProperty('request');
expectTypeOf<ReceiveOnly>().not.toHaveProperty('channel');
expectTypeOf<ReceiveOnly>().not.toHaveProperty('stream');
expectTypeOf<ReceiveOnly>().not.toHaveProperty('onRequest');

// A plugin's channel handle must carry the same channel-scoped primitive
// surface (such as inbox()'s `receivers`) as the top-level socket.
interface InboxPluginContract {
  channels: {
    room: {
      incoming: { message: { text: string } };
      inbox: true;
      readReceipts: true;
    };
    plain: {
      incoming: { message: { text: string } };
    };
  };
}

type InboxPluginSocket = PluginSocket<InboxPluginContract>;
declare const inboxPlugin: InboxPluginSocket;
expectTypeOf(inboxPlugin.channel('room').receivers.get()).toEqualTypeOf<
  ReadonlyMap<string, number>
>();
expectTypeOf(inboxPlugin.channel('room').markAsRead()).toEqualTypeOf<void>();
// @ts-expect-error — 'plain' has no inbox flag, so receivers is absent here too
inboxPlugin.channel('plain').receivers;
