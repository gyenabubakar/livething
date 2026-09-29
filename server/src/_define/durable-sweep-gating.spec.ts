/* oxlint-disable @typescript-eslint/no-explicit-any */
import { server } from '~/_define/server.ts';
import { channels } from '~/channel/capability.ts';
import { cursorStream } from '~/stream-cursor/capability.ts';
import { recordedStream } from '~/stream-recorded/capability.ts';
import { describe, expect, it } from 'vitest';

const SWEEP_TASK = '__livething:stream-durable-sweep';

function sweepCount(def: { primitives: readonly any[] }): number {
  return def.primitives.filter((p) => p.__livething === 'scheduled' && p.taskId === SWEEP_TASK)
    .length;
}

describe('durable-stream retention sweep gating (Minor 1)', () => {
  it('does NOT install the sweep when a stream capability is listed but unused', () => {
    const base = server({ capabilities: [recordedStream()] });
    const def = base.assemble({ handlers: [base.on('noop', { run() {} })] });
    expect(sweepCount(def)).toBe(0);
  });

  it('installs exactly one sweep when a top-level durable stream handler exists', () => {
    const base = server({ capabilities: [recordedStream()] });
    const h = base.recordedStream('history', { async *run() {} } as any);
    const def = base.assemble({ handlers: [h] });
    expect(sweepCount(def)).toBe(1);
  });

  it('installs the sweep when the durable stream is declared inside a channel', () => {
    const base = server({
      capabilities: [channels(), recordedStream()],
    });
    const rooms = base.channel('rooms', {});
    const h = rooms.recordedStream('paginate', { async *run() {} } as any);
    const def = base.assemble({ handlers: [h] });
    expect(sweepCount(def)).toBe(1);
  });

  it('installs exactly one sweep when both cursor and recorded are used (dedup)', () => {
    const base = server({
      capabilities: [cursorStream(), recordedStream()],
    });
    const r = base.cursorStream('rs', { async *run() {} } as any);
    const c = base.recordedStream('rc', { async *run() {} } as any);
    const def = base.assemble({ handlers: [r, c] });
    expect(sweepCount(def)).toBe(1);
  });
});
