/* oxlint-disable @typescript-eslint/no-unused-vars, @typescript-eslint/no-unused-expressions */
import { t } from '~/_api/definitions.ts';
import { define } from '~/_define/define.ts';
import { ack } from '~/ack/capability.ts';
import { channels } from '~/channel/capability.ts';
import { keepalive } from '~/keepalive/capability.ts';
import { scheduled } from '~/scheduled/capability.ts';
import { tags } from '~/tags/capability.ts';
import { describe, expectTypeOf, it } from 'vitest';

interface Env {
  SECRET: string;
}

describe('capability-owned, TS-gated ctx extensions', () => {
  it('omits every capability-owned field on a bare server', () => {
    const base = define({ env: t<Env>() });
    base.on('x', {
      run(ctx) {
        // @ts-expect-error ctx.schedule needs the scheduled() capability
        ctx.schedule;
        // @ts-expect-error ctx.cancelScheduled needs the scheduled() capability
        ctx.cancelScheduled;
        // @ts-expect-error ctx.tags needs the tags() capability
        ctx.tags;
        // @ts-expect-error ctx.ack needs the ack() capability
        ctx.ack;
        // @ts-expect-error ctx.latency needs the keepalive() capability
        ctx.latency;
        // @ts-expect-error ctx.quality needs the keepalive() capability
        ctx.quality;
        // @ts-expect-error ctx.channels needs the channels() capability
        ctx.channels;
        // @ts-expect-error ctx.plugin needs a plugin listed
        ctx.plugin;
        expectTypeOf(ctx.id).toEqualTypeOf<string>();
      },
    });
  });

  it('adds ctx.schedule / ctx.cancelScheduled only with scheduled()', () => {
    const base = define({
      env: t<Env>(),
      capabilities: [scheduled({ cleanup: null })],
    });
    base.on('x', {
      run(ctx) {
        expectTypeOf(ctx.schedule).toBeFunction();
        expectTypeOf(ctx.cancelScheduled).toBeFunction();
      },
    });
  });

  it('adds ctx.ack only with ack()', () => {
    const base = define({ env: t<Env>(), capabilities: [ack()] });
    base.on('x', {
      run(ctx) {
        expectTypeOf(ctx.ack).toBeFunction();
      },
    });
  });

  it('adds ctx.latency / ctx.quality only with keepalive()', () => {
    const base = define({
      env: t<Env>(),
      capabilities: [keepalive({ pingIntervalMs: 1_000, idleTimeoutMs: 2_000 })],
    });
    base.on('x', {
      run(ctx) {
        expectTypeOf(ctx.latency).toEqualTypeOf<number | null>();
        expectTypeOf(ctx.quality).toEqualTypeOf<
          'excellent' | 'good' | 'degraded' | 'poor' | null
        >();
      },
    });
  });

  it('adds ctx.tags only with tags()', () => {
    const base = define({
      env: t<Env>(),
      capabilities: [tags((ephemeral) => [ephemeral('role', t<string>())])],
    });
    base.on('x', {
      run(ctx) {
        expectTypeOf(ctx.tags).not.toBeUndefined();
      },
    });
  });

  it('adds ctx.channels only with channels()', () => {
    const base = define({ env: t<Env>(), capabilities: [channels()] });
    base.on('x', {
      run(ctx) {
        expectTypeOf(ctx.channels.get).toBeFunction();
      },
    });
  });
});
