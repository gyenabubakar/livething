// The polls plugin's assembled slice, as the Plugins overview page (polls/polls-definition.ts) builds it in step 2.
import { h, vote } from './polls-slice';

export const definition = h.assemble({
  handlers: [vote],
  api(ctx) {
    return {
      async createPoll(question: string, options: string[]) {
        const pollId = crypto.randomUUID();
        await ctx.kv.set(
          `poll:${pollId}`,
          Object.fromEntries(options.map((option) => [option, 0])),
        );
        await ctx.kv.set(`poll-question:${pollId}`, question);
        return pollId;
      },
      async results(pollId: string) {
        return ((await ctx.kv.get(`poll:${pollId}`)) as Record<string, number> | undefined) ?? {};
      },
    };
  },
});
