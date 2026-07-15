/* oxlint-disable @typescript-eslint/no-explicit-any */
import { t } from '~/_api/definitions.ts';
import { define } from '~/_define/define.ts';
import { compileHandlerDefinition } from '~/_engine/compile/compile.ts';
import { persistence } from '~/persistence/capability.ts';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { recordedStream } from './capability.ts';

interface Env {
  SECRET: string;
}

describe('recordedStream() capability', () => {
  it('registers a recorded stream that boots when persistence is listed', () => {
    const base = define({ env: t<Env>(), capabilities: [persistence(), recordedStream()] });
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

  it('requires the persistence() capability', () => {
    const base = define({ env: t<Env>(), capabilities: [recordedStream()] });
    const handle = base.recordedStream('t', { async *run() {} });
    expect(() => base.assemble({ handlers: [handle] })).toThrow(/persistence\(\) capability/);
  });

  it('throws when base.recordedStream() is used without the capability', () => {
    const base = define({ env: t<Env>() });
    const escapeHatch = base as unknown as { recordedStream(event: string, config: any): unknown };
    expect(() => escapeHatch.recordedStream('x', { async *run() {} })).toThrow(
      /base\.recordedStream\(\) needs the recordedStream\(\) capability/,
    );
  });
});
