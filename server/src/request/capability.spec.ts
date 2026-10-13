import { WIRE_LIMITS } from '@livething/core';
import { t } from '~/_api/definitions.ts';
import { server } from '~/_define/server.ts';
import { compileServerDefinition } from '~/_engine/compile/compile.ts';
import * as v from 'valibot';
import { describe, expect, it, vi } from 'vitest';
import { clientRequests } from './client-requests.ts';
import { serverRequests } from './server-requests.ts';
import type { RequestPrimitive } from './request.ts';

function requestPrimitive(primitives: readonly { __livething: string }[]): RequestPrimitive {
  const found = primitives.find((p) => p.__livething === 'request');
  if (!found) throw new Error('no request primitive');

  return found as unknown as RequestPrimitive;
}

describe('clientRequests() capability', () => {
  it('registers client-to-server handlers with clientRequests()', () => {
    const base = server({ capabilities: [clientRequests()] });
    const handler = base.request('save', { run: () => ({ ok: true }) });
    expect(
      compileServerDefinition(base.assemble({ handlers: [handler] })).requests.has('save'),
    ).toBe(true);
  });

  it('registers a request handler that boots and responds with the return value', async () => {
    const base = server({ capabilities: [clientRequests()] });
    const handleGetTime = base.request('get-time', {
      input: v.object({}),
      run() {
        return { now: 'noon' };
      },
    });
    const definition = base.assemble({ handlers: [handleGetTime] });
    const compiled = compileServerDefinition(definition);
    expect(compiled.requests.has('get-time')).toBe(true);

    const respond = vi.fn();
    await requestPrimitive(definition.primitives).handler({ respond } as never, {});
    expect(respond).toHaveBeenCalledWith({ now: 'noon' });
  });

  it('does not respond when the handler returns nothing', async () => {
    const base = server({ capabilities: [clientRequests()] });
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

  it('responds with an empty object, which is not a void ack', async () => {
    const base = server({ capabilities: [clientRequests()] });
    const handleCount = base.request('count', {
      run() {
        return {};
      },
    });
    const respond = vi.fn();
    await requestPrimitive(base.assemble({ handlers: [handleCount] }).primitives).handler(
      { respond } as never,
      {},
    );
    expect(respond).toHaveBeenCalledWith({});
  });

  it('responds with a falsy value cast past the types, not a void ack', async () => {
    const base = server({ capabilities: [clientRequests()] });
    const handleCount = base.request('count', {
      run() {
        return 0 as never;
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
    const base = server({ capabilities: [clientRequests()] });
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
    const base = server({});
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
