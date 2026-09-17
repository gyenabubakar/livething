/* oxlint-disable @typescript-eslint/no-explicit-any */
import { server } from '~/_define/server.ts';
import { compileHandlerDefinition } from '~/_engine/compile/compile.ts';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { recordedStream } from './capability.ts';

describe('recordedStream() capability', () => {
  it('registers a recorded stream that boots', () => {
    const base = server({ capabilities: [recordedStream()] });
    const handle = base.recordedStream('tokens', {
      input: v.object({}),
      maxChunks: 100,
      async *run() {
        yield { token: 'a' };
      },
    });
    const compiled = compileHandlerDefinition(base.assemble({ handlers: [handle] }));
    expect(compiled.recordedStreams.has('tokens')).toBe(true);
  });

  it('throws when base.recordedStream() is used without the capability', () => {
    const base = server({});
    const escapeHatch = base as unknown as { recordedStream(event: string, config: any): unknown };
    expect(() => escapeHatch.recordedStream('x', { async *run() {} })).toThrow(
      /base\.recordedStream\(\) needs the recordedStream\(\) capability/,
    );
  });
});
