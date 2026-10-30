/* oxlint-disable no-unused-vars */
/**
 * Compile-time fixture: a dynamic channel's `{name}` template captures are
 * inferred onto `ctx.channel.params`, typed from the `{name}` captures in the
 * pattern.
 */
import { server } from '~/_define/server.ts';
import { channels } from '~/channel/capability.ts';
import type { ExtractParams } from '~/channel/channel.ts';

const _single: ExtractParams<'room:{id}'> = { id: 'x' };
void _single;

const _multi: ExtractParams<'org:{org}/thread:{tid}'> = { org: 'a', tid: 'b' };
void _multi;

// A paramless template infers the empty object.
const _none: ExtractParams<'lobby'> = {};
void _none;

const base = server({ capabilities: [channels()] });

const rooms = base.channel(['rooms', 'room:{id}']);
rooms.on('ping', {
  run(ctx) {
    const id: string = ctx.channel.params.id;
    void id;
    // @ts-expect-error — 'missing' was never declared in the template
    void ctx.channel.params.missing;
  },
});

const threads = base.channel(['threads', 'org:{org}/thread:{tid}']);
threads.on('ping', {
  run(ctx) {
    const org: string = ctx.channel.params.org;
    const tid: string = ctx.channel.params.tid;
    void [org, tid];
  },
});

// @ts-expect-error — a stray '{' outside a capture is rejected
base.channel(['configs', 'cfg{{x}}:{id}']);
// @ts-expect-error — a stray '}' outside a capture is rejected
base.channel(['configs', 'cfg:{id}}']);
// @ts-expect-error — an unclosed '{' is rejected
base.channel(['configs', 'cfg:{id']);
