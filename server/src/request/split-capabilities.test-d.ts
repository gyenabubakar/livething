import { t } from '~/_api/definitions.ts';
import { define } from '~/_define/define.ts';
import { channels } from '~/channel/capability.ts';
import { emits } from '~/emits/emits.ts';
import { clientRequests } from '~/request/client-requests.ts';
import { serverRequests } from '~/request/server-requests.ts';
import * as v from 'valibot';

const clientOnly = define({ env: t<{}>(), capabilities: [clientRequests()] });
clientOnly.request('save', {
  input: v.object({ value: v.string() }),
  run(_ctx, input) {
    return { saved: input.value };
  },
});

const outbound = define({ env: t<{}>(), capabilities: [channels(), serverRequests()] });
const room = outbound.channel('room', {
  capabilities: [
    emits({ joined: t<{ id: string }>() }),
    serverRequests({
      confirm: { out: t<{ action: string }>(), in: v.object({ ok: v.boolean() }) },
    }),
  ],
});
room.on('message', {
  run(ctx) {
    ctx.channel.send('joined', { id: 'a' });
    void ctx.channel.request('confirm', { action: 'leave' });
  },
});

const noOutbound = define({ env: t<{}>(), capabilities: [channels()] });
// @ts-expect-error channel serverRequests needs a root serverRequests() runtime
noOutbound.channel('room', {
  capabilities: [serverRequests({ confirm: { out: t<{}>(), in: v.object({ ok: v.boolean() }) } })],
});
