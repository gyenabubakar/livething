import { WIRE_LIMITS } from '@wskit/core';
import { t } from '~/_api/definitions.ts';
import { define } from '~/_define/define.ts';
import { compileHandlerDefinition } from '~/_engine/compile/compile.ts';
import * as v from 'valibot';
import { describe, expect, it, vi } from 'vitest';
import { clientRequests } from './client-requests.ts';
import { serverRequests } from './server-requests.ts';
import type { RequestPrimitive } from './request.ts';

function requestPrimitive(primitives: readonly { __wskit: string }[]): RequestPrimitive {
  const found = primitives.find((p) => p.__wskit === 'request');
  if (!found) throw new Error('no request primitive');

  return found as unknown as RequestPrimitive;
}

describe('clientRequests() capability', () => {
  it('registers client-to-server handlers with clientRequests()', () => {
    const base = define({ capabilities: [clientRequests()] });
    const handler = base.request('save', { run: () => ({ ok: true }) });
    expect(
      compileHandlerDefinition(base.assemble({ handlers: [handler] })).requests.has('save'),
    ).toBe(true);
  });

  it('registers a request handler that boots and responds with the return value', async () => {
    const base = define({ capabilities: [clientRequests()] });
    const handleGetTime = base.request('get-time', {
      input: v.object({}),
      run() {
        return { now: 'noon' };
      },
    });
    const handler = base.assemble({ handlers: [handleGetTime] });
    const compiled = compileHandlerDefinition(handler);
    expect(compiled.requests.has('get-time')).toBe(true);

    const respond = vi.fn();
    await requestPrimitive(handler.primitives).handler({ respond } as never, {});
    expect(respond).toHaveBeenCalledWith({ now: 'noon' });
  });

  it('does not respond when the handler returns nothing', async () => {
    const base = define({ capabilities: [clientRequests()] });
    const handleNoReply = base.request('no-reply', {
      run() {},
    });
    const respond = vi.fn();
    await requestPrimitive(base.assemble({ handlers: [handleNoReply] }).primitives).handler(
      { respond } as never,
      {},
    );
    expect(respond).not.toHaveBeenCalled();
  });

  it('responds with falsy non-null values', async () => {
    const base = define({ capabilities: [clientRequests()] });
    const handleCount = base.request('count', {
      run() {
        return 0;
      },
    });
    const respond = vi.fn();
    await requestPrimitive(base.assemble({ handlers: [handleCount] }).primitives).handler(
      { respond } as never,
      {},
    );
    expect(respond).toHaveBeenCalledWith(0);
  });

  it('treats an explicit null as a void ack, not a response value', async () => {
    const base = define({ capabilities: [clientRequests()] });
    const handleFind = base.request('find', {
      run() {
        return null;
      },
    });
    const respond = vi.fn();
    await requestPrimitive(base.assemble({ handlers: [handleFind] }).primitives).handler(
      { respond } as never,
      {},
    );
    // `null` is nullish, so the builder leaves it unanswered — the runtime sends
    // the empty correlated frame the client resolves with no value.
    expect(respond).not.toHaveBeenCalled();
  });

  it('throws when base.request is used without the clientRequests() capability', () => {
    const base = define({});
    const escapeHatch = base as unknown as {
      request(event: string, config: { run: () => unknown }): unknown;
    };
    expect(() => escapeHatch.request('get-time', { run: () => ({}) })).toThrow(
      /base\.request\(\) needs clientRequests\(\)/,
    );
  });
});

describe('serverRequests() capability', () => {
  it('rejects a request name that cannot travel on the wire', () => {
    const tooLong = 'e'.repeat(WIRE_LIMITS.event + 1);

    expect(() => serverRequests({ [tooLong]: { out: t<{}>() } })).toThrow(
      /the wire protocol limit is 128/,
    );
  });
});
