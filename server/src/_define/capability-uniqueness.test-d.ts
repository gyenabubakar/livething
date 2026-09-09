import { t } from '~/_api/definitions.ts';
import { define } from '~/_define/define.ts';
import { channels } from '~/channel/capability.ts';
import { emits } from '~/emits/emits.ts';
import { errors } from '~/errors/capability.ts';
import { error } from '~/errors/errors.ts';
import { serverRequests } from '~/request/server-requests.ts';
import * as v from 'valibot';
import { expectTypeOf } from 'vitest';

// @ts-expect-error — each capability may appear once in a capabilities array.
define({ capabilities: [channels(), channels()] });

// @ts-expect-error — event declarations belong in one emits(...) capability.
define({ capabilities: [emits({ first: t<{}>() }), emits({ second: t<{}>() })] });

const DuplicateError = error('duplicate', v.object({}));

// @ts-expect-error — errors() also has one place in this capabilities array.
define({ capabilities: [errors([DuplicateError]), errors([DuplicateError])] });

define({
  scope: 'plugin',
  // @ts-expect-error — plugin-scoped capability lists follow the same rule.
  capabilities: [emits({ first: t<{}>() }), emits({ second: t<{}>() })],
});

const base = define({ capabilities: [channels(), serverRequests()] });

// @ts-expect-error — a channel can list serverRequests() once.
base.channel('duplicate', {
  capabilities: [
    serverRequests({ first: { out: t<{}>(), in: v.object({ first: v.boolean() }) } }),
    serverRequests({ second: { out: t<{}>(), in: v.object({ second: v.boolean() }) } }),
  ],
});

const requests = define({
  capabilities: [
    channels(),
    serverRequests({
      ask: { out: t<{ source: 'app' }>(), in: v.object({ appAnswer: v.boolean() }) },
    }),
  ],
});

const room = requests.channel('room', {
  capabilities: [
    serverRequests({
      ask: { out: t<{ source: 'room' }>(), in: v.object({ roomAnswer: v.boolean() }) },
    }),
  ],
});

room.on('start', {
  run(ctx) {
    expectTypeOf(ctx.request('ask', { source: 'app' })).toEqualTypeOf<
      Promise<{ appAnswer: boolean }>
    >();
    expectTypeOf(ctx.channel.request('ask', { source: 'room' })).toEqualTypeOf<
      Promise<{ roomAnswer: boolean }>
    >();
  },
});

export type {};
