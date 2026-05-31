/* oxlint-disable no-unused-vars */
/**
 * Compile-time fixture: `scope()` template params are inferred onto
 * `ctx.channel.params`, typed from the `{name}` captures in the template.
 */
import { channel, contract, implement, scope, t } from '~/index.ts';
import type { ExtractParams } from '~/channel/channel.ts';

// ---------------------------------------------------------------------------
// ExtractParams — the underlying template-literal inference
// ---------------------------------------------------------------------------

const _single: ExtractParams<'room:{id}'> = { id: 'x' };
void _single;

const _multi: ExtractParams<'org:{org}/thread:{tid}'> = { org: 'a', tid: 'b' };
void _multi;

// A paramless template infers the empty object.
const _none: ExtractParams<'lobby'> = {};
void _none;

// ---------------------------------------------------------------------------
// End-to-end: scope() -> contract -> implement().channel -> ctx.channel.params
// ---------------------------------------------------------------------------

const app = contract('app', {
  env: t<{ X: string }>(),
  definitions: [
    channel(scope('rooms', 'room:{id}'), { definitions: [] }),
    channel(scope('threads', 'org:{org}/thread:{tid}'), { definitions: [] }),
  ],
});

implement(app).channel('rooms', (ch) =>
  ch.onSubscribe((ctx) => {
    const id: string = ctx.channel.params.id;
    void id;
    // @ts-expect-error — 'missing' was never declared in the template
    void ctx.channel.params.missing;
  }),
);

implement(app).channel('threads', (ch) =>
  ch.onSubscribe((ctx) => {
    const org: string = ctx.channel.params.org;
    const tid: string = ctx.channel.params.tid;
    void [org, tid];
  }),
);
