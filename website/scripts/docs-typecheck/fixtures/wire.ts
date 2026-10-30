// The contract of Huddle's polls plugin, as the Plugins chapter writes it in polls/wire.ts.
import type { SocketContract } from '@livething/client';

export interface PollsWire extends SocketContract {
  incoming: {
    'poll-updated': { pollId: string; votes: Record<string, number> };
  };
  outgoing: {
    'watch-poll': { pollId: string };
    hello: { device: string };
    'resync-polls': {};
  };
  clientRequests: {
    'create-poll': {
      payload: { question: string; options: string[] };
      response: { pollId: string };
    };
    vote: {
      payload: { pollId: string; option: string };
      response: { ok: true };
    };
  };
  streams: {
    'poll-history': {
      payload: { before: number };
      chunk: { pollId: string; question: string };
    };
  };
  serverRequests: {
    'confirm-close': {
      payload: { pollId: string };
      response: { closed: boolean };
    };
  };
  channels: {
    'poll-room': {
      addressing: 'dynamic';
      incoming: { 'votes-changed': { votes: Record<string, number> } };
      outgoing: {};
    };
  };
}
