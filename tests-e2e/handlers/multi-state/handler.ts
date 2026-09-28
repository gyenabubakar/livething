/**
 * Fixture for the invocation-scope batching optimisation. Each incoming
 * handler here triggers MANY hibernation row writes — one per tag add. Pre-A
 * that wrote one row per add. Post-A the writes batch into one row at the
 * end of the handler invocation.
 */
import { emits, server, t } from '@livething/server';
import { tags } from '@livething/server/tags';
import * as v from 'valibot';
import type { InferClient } from '@livething/server';
import { requireUsernameWithUserTag } from '../_shared/upgrade.ts';

const TagBatchPayload = v.object({});

const base = server({
  hibernation: { enabled: true },
  upgrade: (request) => requireUsernameWithUserTag(request),
  capabilities: [
    // `user` is consumed by `requireUsernameWithUserTag` from `_shared/upgrade.ts`;
    // `batch` is what the multi-state handlers under test add and remove.
    tags((ephemeral) => [ephemeral('user', t<string>()), ephemeral('batch', t<string>())]),
    emits({ 'tag-batch-done': t<{ ok: boolean }>() }),
  ],
});

const handleAddFiveTags = base.on('add-five-tags', {
  input: TagBatchPayload,
  run(ctx) {
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
  },
});

const handleRemoveFiveTags = base.on('remove-five-tags', {
  input: TagBatchPayload,
  run(ctx) {
    // Same pattern in reverse — five removes per handler invocation.
    ctx.tags.ephemeral('batch').remove('k1');
    ctx.tags.ephemeral('batch').remove('k2');
    ctx.tags.ephemeral('batch').remove('k3');
    ctx.tags.ephemeral('batch').remove('k4');
    ctx.tags.ephemeral('batch').remove('k5');

    ctx.send('tag-batch-done', { ok: true });
  },
});

export const multiStateDefinition = base.assemble({
  handlers: [handleAddFiveTags, handleRemoveFiveTags],
});

export type MultiStateClient = InferClient<typeof multiStateDefinition>;
