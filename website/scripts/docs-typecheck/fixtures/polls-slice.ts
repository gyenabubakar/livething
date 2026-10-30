// The polls plugin's scoped builder and vote handler, as the Plugins overview page (polls/polls-slice.ts) builds them in step 1.
import { emits, server, t } from '@livething/server';
import * as v from 'valibot';

export const h = server({
  scope: 'plugin',
  capabilities: [
    emits({
      'poll-updated': t<{
        pollId: string;
        votes: Record<string, number>;
      }>(),
    }),
  ],
});

export const vote = h.on('vote', {
  input: v.object({ pollId: v.string(), option: v.string() }),
  async run(ctx, input) {
    const votes =
      ((await ctx.kv.get(`poll:${input.pollId}`)) as Record<string, number> | undefined) ?? {};
    votes[input.option] = (votes[input.option] ?? 0) + 1;
    await ctx.kv.set(`poll:${input.pollId}`, votes);
    ctx.send('poll-updated', { pollId: input.pollId, votes });
  },
});
