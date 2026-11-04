// Huddle's client contract with the polls plugin added: the plugin's names carry the __acme:polls:: prefix.
export interface HuddleWithPolls {
  incoming: {
    notification: { title: string; body: string };
    '__acme:polls::poll-updated': { pollId: string; votes: Record<string, number> };
  };
  outgoing: {
    '__acme:polls::watch-poll': { pollId: string };
    '__acme:polls::hello': { device: string };
    '__acme:polls::resync-polls': {};
  };
  clientRequests: {
    '__acme:polls::create-poll': {
      payload: { question: string; options: string[] };
      response: { pollId: string };
    };
    '__acme:polls::vote': {
      payload: { pollId: string; option: string };
      response: { ok: true };
    };
  };
  streams: {
    '__acme:polls::poll-history': {
      payload: { before: number };
      chunk: { pollId: string; question: string };
    };
  };
  serverRequests: {
    '__acme:polls::confirm-close': {
      payload: { pollId: string };
      response: { closed: boolean };
    };
  };
  channels: {
    '__acme:polls::poll-room': {
      addressing: 'dynamic';
      incoming: { 'votes-changed': { votes: Record<string, number> } };
      outgoing: {};
    };
  };
  errors: {
    '__acme:polls::poll-closed': { closedAt: number };
  };
}

export type AppContract = HuddleWithPolls;
