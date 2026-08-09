/* oxlint-disable @typescript-eslint/no-explicit-any */
import { t } from '~/_api/definitions.ts';
import { define } from '~/_define/define.ts';
import { channels } from '~/channel/capability.ts';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { recordedStream } from './capability.ts';
import { compileRecordedStreamDef } from './compile.ts';
import { recordedStream as recordedStreamDef } from './definition.ts';

describe('recordedStream build-time validation', () => {
  it('builds when declared inside a channel', () => {
    const base = define({
      env: t<Record<string, unknown>>(),
      capabilities: [channels(), recordedStream()],
    });
    const rooms = base.channel('rooms');
    const handle = rooms.recordedStream('tokens', {
      input: v.object({}),
      chunk: t<{ token: string }>(),
      async *run() {
        yield { token: 'hi' };
      },
    });
    expect(() => base.assemble({ handlers: [handle] })).not.toThrow();
  });

  it('builds when the stream is top-level', () => {
    const base = define({
      env: t<Record<string, unknown>>(),
      capabilities: [recordedStream()],
    });
    const handle = base.recordedStream('tokens', {
      input: v.object({}),
      chunk: t<{ token: string }>(),
      async *run() {
        yield { token: 'hi' };
      },
    });
    expect(() => base.assemble({ handlers: [handle] })).not.toThrow();
  });

  // FLAGGED: the new API has no "declaration without a handler" state — a
  // base.recordedStream(...) call always carries its generator, so the missing-
  // generator path in compile.ts is unreachable through define()/assemble(). The
  // assertion is preserved by driving compileRecordedStreamDef directly with an
  // empty handler map, the same path the capability builder feeds.
  it('throws at build when a recordedStream declaration has no handler', () => {
    const def = recordedStreamDef('tokens', {
      payload: v.object({}),
    });
    expect(() => compileRecordedStreamDef(def, new Map())).toThrow(
      /No generator registered for recordedStream/,
    );
  });
});
