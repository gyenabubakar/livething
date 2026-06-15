import { t } from '~/_api/definitions.ts';
import { define } from '~/_define/define.ts';
import { compileHandlerDefinition } from '~/_engine/compile/compile.ts';
import * as v from 'valibot';
import { describe, expect, it, vi } from 'vitest';
import { requests } from './capability.ts';
import type { RequestPrimitive } from './request.ts';

interface Env {
  SECRET: string;
}

function requestPrimitive(primitives: readonly { __wskit: string }[]): RequestPrimitive {
  const found = primitives.find((p) => p.__wskit === 'request');
  if (!found) throw new Error('no request primitive');
  return found as unknown as RequestPrimitive;
}

describe('requests() capability — client to server', () => {
  it('registers a request handler that boots and responds with the return value', async () => {
    const base = define({ env: t<Env>(), capabilities: [requests()] });
    const handleGetTime = base.request('get-time', {
      input: v.object({}),
      run() {
        return { now: 'noon' };
      },
    });
    const handler = base.assemble(handleGetTime);
    const compiled = compileHandlerDefinition(handler);
    expect(compiled.requests.has('get-time')).toBe(true);

    const respond = vi.fn();
    await requestPrimitive(handler.primitives).handler({ respond } as never, {});
    expect(respond).toHaveBeenCalledWith({ now: 'noon' });
  });

  it('does not respond when the handler returns nothing', async () => {
    const base = define({ env: t<Env>(), capabilities: [requests()] });
    const handleNoReply = base.request('no-reply', {
      run() {},
    });
    const respond = vi.fn();
    await requestPrimitive(base.assemble(handleNoReply).primitives).handler(
      { respond } as never,
      {},
    );
    expect(respond).not.toHaveBeenCalled();
  });

  it('responds with falsy non-null values', async () => {
    const base = define({ env: t<Env>(), capabilities: [requests()] });
    const handleCount = base.request('count', {
      run() {
        return 0;
      },
    });
    const respond = vi.fn();
    await requestPrimitive(base.assemble(handleCount).primitives).handler({ respond } as never, {});
    expect(respond).toHaveBeenCalledWith(0);
  });

  it('throws when base.request is used without the requests() capability', () => {
    const base = define({ env: t<Env>() });
    const escapeHatch = base as unknown as {
      request(event: string, config: { run: () => unknown }): unknown;
    };
    expect(() => escapeHatch.request('get-time', { run: () => ({}) })).toThrow(
      /base\.request\(\) needs the requests\(\) capability/,
    );
  });
});
