/* oxlint-disable @typescript-eslint/no-explicit-any */
import { t } from '~/_api/definitions.ts';
import { server } from '~/_define/server.ts';
import { channels } from '~/channel/capability.ts';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { recordedStream } from './capability.ts';
import { compileRecordedStreamDef } from './compile.ts';
import { recordedStream as recordedStreamDef } from './definition.ts';

describe('recordedStream build-time validation', () => {
  it('builds when declared inside a channel', () => {
    const base = server({
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
    const base = server({
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
  // generator path in compile.ts is unreachable through server()/assemble(). The
  // assertion is preserved by driving compileRecordedStreamDef directly with an
  // empty handler map, the same path the capability builder feeds.
  it('throws when a recordedStream handler is not assembled', () => {
    const def = recordedStreamDef('tokens', {
      payload: v.object({}),
    });
    expect(() => compileRecordedStreamDef(def, new Map())).toThrow(
      /No handler assembled for recordedStream/,
    );
  });
});
