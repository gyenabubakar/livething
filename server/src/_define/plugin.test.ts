/* oxlint-disable @typescript-eslint/no-unused-vars */
import { t } from '~/_api/definitions.ts';
import { define } from '~/_define/define.ts';
import { emits } from '~/emits/emits.ts';
import { keepalive } from '~/keepalive/capability.ts';
import * as v from 'valibot';
import { describe, expectTypeOf, it } from 'vitest';
import { plugin } from './plugin.ts';

interface Env {
  SECRET: string;
}

interface PresenceApi {
  announce(): void;
  count(): number;
}

const h = define({
  scoped: true,
  capabilities: [emits({ 'user-online': t<{ id: string }>() })],
});
const heartbeat = h.on('heartbeat', { input: v.object({}), run() {} });

const Presence = plugin('acme:presence', {
  handler: h.assemble(heartbeat),
  api: (): PresenceApi => ({ announce() {}, count: () => 0 }),
});

const base = define({ env: t<Env>(), capabilities: [Presence] });

describe('plugin typing', () => {
  it('accepts a plugin capability in define({ capabilities })', () => {
    expectTypeOf(base.on).toBeFunction();
  });

  it('types ctx.plugin via the explicit api type argument', () => {
    base.on('act', {
      run(ctx) {
        const api = ctx.plugin<PresenceApi>('acme:presence');
        expectTypeOf(api).toEqualTypeOf<PresenceApi>();
        expectTypeOf(api.count()).toEqualTypeOf<number>();
      },
    });
  });

  it('lets a scoped handler use the same builders as an app', () => {
    expectTypeOf(h.on).toBeFunction();
    expectTypeOf(h.assemble).toBeFunction();
  });

  it('rejects a host-owned capability inside a scoped define at compile time', () => {
    // @ts-expect-error keepalive() is host-owned and cannot be listed in a plugin
    define({
      scoped: true,
      capabilities: [keepalive({ pingIntervalMs: 1_000, idleTimeoutMs: 2_000 })],
    });
  });
});
