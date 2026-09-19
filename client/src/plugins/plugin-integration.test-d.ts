// Integration type checks: the plugin factory wired through the real `client()`
// call, not the strip/slice helpers in isolation. This is the path where a plugin
// id must survive as a literal so the app socket strips only the claimed
// namespace. tsc checks these; vitest never runs them.
import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { plugin } from '~/plugins/plugins.ts';
import { clientRequests } from '~/primitives/client-requests/index.ts';
import { expectTypeOf } from 'vitest';

// A contract shaped like `InferClient`: the app's own names, one plugin's names
// under `__acme:chat::`, and a SECOND namespace `__acme:presence::` that no plugin
// claims — it must stay reachable at the top level.
interface HostContract {
  incoming: {
    'app-notice': { text: string };
    '__acme:chat::message': { id: string; text: string };
    '__acme:presence::here': { who: string };
  };
  outgoing: {
    'app-ping': { at: number };
    '__acme:chat::typing': { on: boolean };
  };
  clientRequests: {
    '__acme:chat::send-message': { payload: { text: string }; response: { id: string } };
  };
}

interface ChatWire {
  incoming: { message: { id: string; text: string } };
  outgoing: { typing: { on: boolean } };
  clientRequests: { 'send-message': { payload: { text: string }; response: { id: string } } };
}

interface ChatApi {
  send(text: string): Promise<{ id: string }>;
}

const Chat = plugin<ChatWire, ChatApi>()({
  id: 'acme:chat',
  dependencies: [clientRequests],
  setup: (socket) => ({
    api: () => ({ send: (text) => socket.request('send-message', { text }) }),
  }),
});

// The id must be the literal 'acme:chat', NOT string. If it collapsed to string,
// the app socket would strip every `__x::` name (the bug this pins against).
expectTypeOf<typeof Chat.id>().toEqualTypeOf<'acme:chat'>();
expectTypeOf<ReturnType<typeof Chat>['_plugin']['id']>().toEqualTypeOf<'acme:chat'>();

const socket = client<HostContract>()(connect('wss://example.com'), clientRequests(), Chat());

// The app's own top-level names stay, with exact payload types (never `any`).
socket.on('app-notice', (data) => {
  expectTypeOf(data).toEqualTypeOf<{ text: string }>();
  expectTypeOf(data).not.toBeAny();
});
expectTypeOf(socket.send('app-ping', { at: 1 })).toEqualTypeOf<boolean>();

// The unclaimed namespace remains available and fully typed at the top level.
socket.on('__acme:presence::here', (data) => {
  expectTypeOf(data).toEqualTypeOf<{ who: string }>();
  expectTypeOf(data).not.toBeAny();
});

// The CLAIMED namespace is not reachable at the top level — reach it through the plugin.
// @ts-expect-error — '__acme:chat::message' is claimed by the Chat plugin
socket.on('__acme:chat::message', () => {});
// @ts-expect-error — '__acme:chat::typing' is claimed by the Chat plugin
socket.send('__acme:chat::typing', { on: true });
// @ts-expect-error — '__acme:chat::send-message' is claimed by the Chat plugin
socket.request('__acme:chat::send-message', { text: 'hi' });

// The plugin's API comes off the socket, exactly typed (not `any`/`unknown`).
const chat = Chat.use(socket);
expectTypeOf(chat).toEqualTypeOf<ChatApi>();
expectTypeOf(chat.send('hi')).resolves.toEqualTypeOf<{ id: string }>();
expectTypeOf(chat).not.toBeAny();

// With NO plugin registered, both namespaces stay at the top level, unchanged.
const bare = client<HostContract>()(connect('wss://example.com'), clientRequests());
bare.on('__acme:chat::message', (data) =>
  expectTypeOf(data).toEqualTypeOf<{ id: string; text: string }>(),
);
bare.on('__acme:presence::here', (data) => expectTypeOf(data).toEqualTypeOf<{ who: string }>());

// Register-time matching: a plugin can only be registered onto a socket whose
// contract declares its namespace. A contract missing `__acme:chat::*` rejects it.
// (The requirement failure lands on the whole call, so the directive sits above it.)
interface NoChatContract {
  incoming: { 'app-notice': { text: string } };
}

// @ts-expect-error — NoChatContract has no __acme:chat:: names, so Chat can't register
client<NoChatContract>()(connect('wss://example.com'), clientRequests(), Chat());

// A contract that DOES declare the namespace accepts it.
client<HostContract>()(connect('wss://example.com'), clientRequests(), Chat());

// A hook-only plugin (no contract) requires nothing and registers anywhere.
const Watcher = plugin()({ id: 'acme:watcher', setup: () => ({}) });
client<NoChatContract>()(connect('wss://example.com'), Watcher());

// The API type comes from what `setup` returns, so a plugin only needs its
// contract type argument. `use()` still gives the full API.
const Inferred = plugin<ChatWire>()({
  id: 'acme:inferred',
  dependencies: [clientRequests],
  setup: (socket) => ({
    api: () => ({
      send: (text: string) => socket.request('send-message', { text }),
      seen: 0,
    }),
  }),
});
expectTypeOf(Inferred.use({})).toEqualTypeOf<{
  send: (text: string) => Promise<{ id: string }>;
  seen: number;
}>();

// With no contract at all the API is still inferred.
const Counter = plugin()({
  id: 'acme:counter',
  setup: () => ({ api: () => ({ count: (): number => 1 }) }),
});
expectTypeOf(Counter.use({})).toEqualTypeOf<{ count: () => number }>();

// A plugin whose `setup` returns no `api` has a void API.
expectTypeOf(Watcher.use({})).toEqualTypeOf<void>();

// The explicit second type argument still pins the API when you want it.
expectTypeOf(Chat.use({})).toEqualTypeOf<ChatApi>();
