/* oxlint-disable @typescript-eslint/no-explicit-any */
import { define } from '~/_define/define.ts';
import { channels } from '~/channel/capability.ts';
import { t } from '~/index.ts';
import { persistence } from '~/persistence/capability.ts';
import { recordedStream } from '~/stream-recorded/capability.ts';
import { resumableStream } from '~/stream-resumable/capability.ts';
import { describe, expect, it } from 'vitest';

const SWEEP_TASK = '__wskit:stream-durable-sweep';

function sweepCount(def: { primitives: readonly any[] }): number {
  return def.primitives.filter((p) => p.__wskit === 'scheduled' && p.taskId === SWEEP_TASK).length;
}

describe('durable-stream retention sweep gating (Minor 1)', () => {
  it('does NOT install the sweep when a stream capability is listed but unused', () => {
    const base = define({ env: t<{}>(), capabilities: [persistence(), recordedStream()] });
    const def = base.assemble({ handlers: [base.on('noop', { run() {} })] });
    expect(sweepCount(def)).toBe(0);
  });

  it('installs exactly one sweep when a top-level durable stream handler exists', () => {
    const base = define({ env: t<{}>(), capabilities: [persistence(), recordedStream()] });
    const h = base.recordedStream('history', { async *run() {} } as any);
    const def = base.assemble({ handlers: [h] });
    expect(sweepCount(def)).toBe(1);
  });

  it('installs the sweep when the durable stream is declared inside a channel', () => {
    const base = define({
      env: t<{}>(),
      capabilities: [persistence(), channels(), recordedStream()],
    });
    const rooms = base.channel('rooms', {});
    const h = rooms.recordedStream('paginate', { async *run() {} } as any);
    const def = base.assemble({ handlers: [h] });
    expect(sweepCount(def)).toBe(1);
  });

  it('installs exactly one sweep when both resumable and recorded are used (dedup)', () => {
    const base = define({
      env: t<{}>(),
      capabilities: [persistence(), resumableStream(), recordedStream()],
    });
    const r = base.resumableStream('rs', { async *run() {} } as any);
    const c = base.recordedStream('rc', { async *run() {} } as any);
    const def = base.assemble({ handlers: [r, c] });
    expect(sweepCount(def)).toBe(1);
  });
});
