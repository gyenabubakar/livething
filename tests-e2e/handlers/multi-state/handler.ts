/**
 * Fixture for the invocation-scope batching optimisation. Each incoming
 * handler here triggers MANY hibernation row writes — one per tag add. Pre-A
 * that wrote one row per add. Post-A the writes batch into one row at the
 * end of the handler invocation.
 */
import { contract, implement, incoming, outgoing, t } from '@wskit/server';
import * as v from 'valibot';
import { requireUsername } from '../_shared/upgrade.ts';

const TagBatchPayload = v.object({});
const TagBatchResult = v.object({ ok: v.boolean() });

export const multiStateContract = contract('multi-state', {
  env: t<Env>(),
  hibernation: true,
  meta: t<{ username: string }>(),
  // `user` is consumed by `requireUsername` from `_shared/upgrade.ts`;
  // `batch` is what the multi-state handlers under test add and remove.
  tags: (ephemeral) => [ephemeral('user', t<string>()), ephemeral('batch', t<string>())],
  definitions: [
    incoming('add-five-tags', TagBatchPayload),
    incoming('remove-five-tags', TagBatchPayload),
    outgoing('tag-batch-done', TagBatchResult),
  ],
});

export const multiStateHandler = implement(multiStateContract)
  .onUpgrade((request, helpers) => requireUsername(request, helpers))
  .on('add-five-tags', (ctx) => {
    // Five ephemeral tag adds in one handler. Each call into
    // `ctx.tags.ephemeral(...).add(...)` calls `persistAttachment` under the
    // hood — pre-A that meant five hibernation row writes; post-A the
    // invocation scope coalesces them into one write at the end.
    ctx.tags.ephemeral('batch').add('k1');
    ctx.tags.ephemeral('batch').add('k2');
    ctx.tags.ephemeral('batch').add('k3');
    ctx.tags.ephemeral('batch').add('k4');
    ctx.tags.ephemeral('batch').add('k5');
    ctx.send('tag-batch-done', { ok: true });
  })
  .on('remove-five-tags', (ctx) => {
    // Same pattern in reverse — five removes per handler invocation.
    ctx.tags.ephemeral('batch').remove('k1');
    ctx.tags.ephemeral('batch').remove('k2');
    ctx.tags.ephemeral('batch').remove('k3');
    ctx.tags.ephemeral('batch').remove('k4');
    ctx.tags.ephemeral('batch').remove('k5');
    ctx.send('tag-batch-done', { ok: true });
  })
  .build();
