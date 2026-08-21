/* oxlint-disable @typescript-eslint/no-explicit-any */
import { t } from '~/_api/definitions.ts';
import { define } from '~/_define/define.ts';
import { compileHandlerDefinition } from '~/_engine/compile/compile.ts';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { resumableStream } from './capability.ts';

interface Env {
  SECRET: string;
}

describe('resumableStream() capability', () => {
  it('registers a resumable stream that boots', () => {
    const base = define({ env: t<Env>(), capabilities: [resumableStream()] });
    const handle = base.resumableStream('paginate', {
      input: v.object({}),
      cursor: t<{ row: number }>(),
      async *run(ctx) {
        const start = ctx.stream.cursor?.row ?? 0;
        yield ctx.stream.withCursor({ row: start + 1 }, { row: start + 1 });
      },
    });
    const compiled = compileHandlerDefinition(base.assemble({ handlers: [handle] }));
    expect(compiled.resumableStreams.has('paginate')).toBe(true);
  });

  it('rejects keep-running without broadcast', () => {
    const base = define({ env: t<Env>(), capabilities: [resumableStream()] });
    expect(() =>
      base.resumableStream('p', { onDisconnect: 'keep-running', async *run() {} }),
    ).toThrow(/keep-running/);
  });

  it('lets the generator read cursor and use withCursor through the wrapper', async () => {
    const base = define({ env: t<Env>(), capabilities: [resumableStream()] });
    let seenCursor: unknown;
    const handle = base.resumableStream('p', {
      chunk: t<{ row: number }>(),
      cursor: t<{ row: number }>(),
      async *run(ctx) {
        seenCursor = ctx.stream.cursor;
        yield ctx.stream.withCursor({ row: 9 }, { row: 9 });
      },
    });
    const primitive = base
      .assemble({ handlers: [handle] })
      .primitives.find((p) => p.__wskit === 'resumable-stream-generate') as any;

    const ctx: any = {
      nudges: (value: unknown) => (Array.isArray(value) ? value : []),
      stream: {
        id: 's',
        cursor: { row: 4 },
        attempt: 2,
        withCursor: (chunk: unknown, cursor: unknown) => ({ chunk, cursor }),
      },
    };
    const iterator = primitive.generator(ctx, {});
    const first = await iterator.next();

    expect(seenCursor).toEqual({ row: 4 });
    expect(first.value).toEqual({ chunk: { row: 9 }, cursor: { row: 9 } });
  });

  it('throws when base.resumableStream() is used without the capability', () => {
    const base = define({ env: t<Env>() });
    const escapeHatch = base as unknown as { resumableStream(event: string, config: any): unknown };
    expect(() => escapeHatch.resumableStream('x', { async *run() {} })).toThrow(
      /base\.resumableStream\(\) needs the resumableStream\(\) capability/,
    );
  });
});
