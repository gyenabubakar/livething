// Type-only checks for the plugin socket. tsc checks these; vitest never runs them.
import { expectTypeOf } from 'vitest';
import type { PluginSocket } from '~/plugins/plugin-socket.ts';

interface ChatContract {
  incoming: { message: { id: string; text: string } };
  outgoing: { typing: { on: boolean } };
  requests: { 'send-message': { payload: { text: string }; response: { id: string } } };
  channels: { room: { incoming: { reaction: { emoji: string } } } };
  streams: { feed: { payload: { from: number }; chunk: { row: number } } };
  serverRequests: { ping: { payload: { at: number }; response: { pong: boolean } } };
}

type ChatSocket = PluginSocket<ChatContract>;

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

// Typed channel handle.
expectTypeOf<ChatSocket['channel']>().toBeFunction();
expectTypeOf<Parameters<ChatSocket['channel']>[0]>().toEqualTypeOf<'room'>();

// Typed streams.
expectTypeOf<ChatSocket['stream']>().toBeFunction();
expectTypeOf<Parameters<ChatSocket['stream']>[0]>().toEqualTypeOf<'feed'>();
expectTypeOf<ChatSocket['onStream']>().toBeFunction();
expectTypeOf<ChatSocket['resumeStream']>().toBeFunction();

// Typed server→client request handler.
expectTypeOf<ChatSocket['onRequest']>().toBeFunction();
expectTypeOf<Parameters<ChatSocket['onRequest']>[0]>().toEqualTypeOf<'ping'>();

// The always-present taps and tools are there too.
expectTypeOf<ChatSocket['onIncoming']>().toBeFunction();
expectTypeOf<ChatSocket['onOutgoing']>().toBeFunction();
expectTypeOf<ChatSocket['onOpen']>().toBeFunction();
expectTypeOf<ChatSocket['onClose']>().toBeFunction();
expectTypeOf<ChatSocket['generateId']>().toBeFunction();
expectTypeOf<ChatSocket['hasPrimitive']>().toBeFunction();

// A plugin with no contract (observe-only) has the taps and tools but none of the
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

// A plugin that only receives (incoming, no requests/channels/streams) has `on`
// but none of the other verbs.
type ReceiveOnly = PluginSocket<{ incoming: { tick: { n: number } } }>;
expectTypeOf<ReceiveOnly['on']>().toBeFunction();
expectTypeOf<ReceiveOnly>().not.toHaveProperty('request');
expectTypeOf<ReceiveOnly>().not.toHaveProperty('channel');
expectTypeOf<ReceiveOnly>().not.toHaveProperty('stream');
expectTypeOf<ReceiveOnly>().not.toHaveProperty('onRequest');
