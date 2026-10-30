// Huddle's polls client plugin, as the Plugins chapter builds it in polls/client.ts.
import { channels, clientRequests, plugin } from '@livething/client';
import type { PollsWire } from './wire';

export interface PollsApi {
  latest(): { pollId: string; votes: Record<string, number> } | null;
  create(question: string, options: string[]): Promise<{ pollId: string }>;
  vote(pollId: string, option: string): Promise<{ ok: true }>;
  onUpdate(callback: (pollId: string, votes: Record<string, number>) => void): void;
  watch(pollId: string): void;
  watchPoll(pollId: string): Promise<void>;
}

export const Polls = plugin<PollsWire, PollsApi>()({
  id: 'acme:polls',
  dependencies: [clientRequests, channels],
  setup(socket) {
    let latest: { pollId: string; votes: Record<string, number> } | null = null;
    const callbacks = new Set<(pollId: string, votes: Record<string, number>) => void>();
    socket.on('poll-updated', (update) => {
      latest = update;
      callbacks.forEach((callback) => callback(update.pollId, update.votes));
    });
    return {
      api: () => ({
        latest: () => latest,
        create: (question, options) => socket.request('create-poll', { question, options }),
        vote: (pollId, option) => socket.request('vote', { pollId, option }),
        onUpdate: (callback) => void callbacks.add(callback),
        watch: (pollId) => void socket.send('watch-poll', { pollId }),
        watchPoll: (pollId) => socket.channel('poll-room', `poll:${pollId}`).subscribe({}),
      }),
    };
  },
});
