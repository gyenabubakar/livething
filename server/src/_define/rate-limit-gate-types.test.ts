/* oxlint-disable @typescript-eslint/no-unused-vars, @typescript-eslint/no-unused-expressions */
import { t } from '~/_api/definitions.ts';
import { define } from '~/_define/define.ts';
import { channels } from '~/channel/capability.ts';
import { rateLimit } from '~/rate-limit/capability.ts';
import { clientRequests } from '~/request/client-requests.ts';
import * as v from 'valibot';
import { describe, it } from 'vitest';

interface Env {
  SECRET: string;
}

describe('rateLimit override is gated on the rateLimit() capability', () => {
  it('rejects a per-handler rateLimit override when rateLimit() is not listed', () => {
    const base = define({ env: t<Env>(), capabilities: [channels(), clientRequests()] });

    base.on('ping', {
      input: v.object({}),
      // @ts-expect-error per-handler rateLimit override needs the rateLimit() capability
      rateLimit: { enabled: true, max: 1 },
      run() {},
    });

    base.request('ask', {
      input: v.object({}),
      // @ts-expect-error per-handler rateLimit override needs the rateLimit() capability
      rateLimit: { enabled: true, max: 1 },
      run() {
        return {};
      },
    });

    // @ts-expect-error channel-level rateLimit needs the rateLimit() capability
    base.channel('room', { rateLimit: { enabled: true, max: 1 } });

    base.channel('room2').on('say', {
      input: v.object({}),
      // @ts-expect-error per-handler channel rateLimit override needs the rateLimit() capability
      rateLimit: { enabled: true, max: 1 },
      run() {},
    });
  });

  it('accepts a rateLimit override when rateLimit() is listed', () => {
    const base = define({
      env: t<Env>(),
      capabilities: [channels(), clientRequests(), rateLimit({ max: 100 })],
    });

    base.on('ping', {
      input: v.object({}),
      rateLimit: { enabled: true, max: 1 },
      run() {},
    });

    base.request('ask', {
      input: v.object({}),
      rateLimit: { enabled: true, max: 1 },
      run() {
        return {};
      },
    });

    base.channel('room', {
      rateLimit: { enabled: true, max: 1 },
    });

    base.channel('room2').on('say', {
      input: v.object({}),
      rateLimit: { enabled: true, max: 1 },
      run() {},
    });
  });
});
