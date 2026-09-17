/* oxlint-disable @typescript-eslint/no-explicit-any */
import { server } from '~/_define/server.ts';
import { compileServerDefinition } from '~/_engine/compile/compile.ts';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { stream } from './capability.ts';

function streamPrimitive(primitives: readonly { __wskit: string }[]): any {
  const found = primitives.find((p) => p.__wskit === 'stream-generate');
  if (!found) throw new Error('no stream primitive');

  return found;
}

describe('stream() capability', () => {
  it('registers a plain stream that boots', () => {
    const base = server({ capabilities: [stream()] });
    const handleFeed = base.stream('feed', {
      input: v.object({ count: v.number() }),
      async *run(_ctx, input) {
        for (let i = 0; i < input.count; i += 1) yield { index: i };
      },
    });
    const compiled = compileServerDefinition(base.assemble({ handlers: [handleFeed] }));
    expect(compiled.streams.has('feed')).toBe(true);
  });

  it('converts the nudge map into declared nudges', () => {
    const base = server({ capabilities: [stream()] });
    const handle = base.stream('chat', {
      nudges: { cancel: null, 'speed-up': v.object({ factor: v.number() }) },
      async *run() {},
    });
    const primitive = streamPrimitive(base.assemble({ handlers: [handle] }).primitives);
    const names = primitive.stream.nudges.map((n: { event: string }) => n.event).sort();
    expect(names).toEqual(['cancel', 'speed-up']);
  });

  it('feeds nudges to the generator through ctx.stream.nudges', async () => {
    const base = server({ capabilities: [stream()] });
    let seen: string[] = [];
    const handle = base.stream('s', {
      nudges: { go: null },
      async *run(ctx) {
        const got = ctx.stream.nudges(yield {});
        seen = got.map((n) => n.event);
      },
    });
    const primitive = streamPrimitive(base.assemble({ handlers: [handle] }).primitives);
    const ctx: any = { nudges: (value: unknown) => (Array.isArray(value) ? value : []) };

    const iterator = primitive.generator(ctx, {});
    await iterator.next();
    await iterator.next([{ event: 'go' }]);
    expect(seen).toEqual(['go']);
  });

  it('throws when base.stream() is used without the stream() capability', () => {
    const base = server({});
    const escapeHatch = base as unknown as { stream(event: string, config: any): unknown };
    expect(() => escapeHatch.stream('x', { async *run() {} })).toThrow(
      /base\.stream\(\) needs the stream\(\) capability/,
    );
  });

  it('throws when one event name is bound by both a stream and an on handler', () => {
    const base = server({ capabilities: [stream()] });
    const asStream = base.stream('shared', { async *run() {} });
    const asEvent = base.on('shared', { input: v.object({}), run() {} });
    expect(() => base.assemble({ handlers: [asStream, asEvent] })).toThrow(
      /Event name 'shared' is bound by both/,
    );
  });
});
