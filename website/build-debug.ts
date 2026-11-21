import type { Plugin } from 'vite';

// TEMPORARY: finds where the Cloudflare build stalls in "transforming...". Remove it, and its
// line in nuxt.config.ts, once the cause is fixed.
//
// A module is in flight from its first `load` to the end of its last `transform`. Every 30 s
// the build prints the hook it last entered and every module in flight, and any module that
// took over 5 s is printed once it ends.
const HEARTBEAT_MS = 30_000;
const SLOW_MS = 5_000;

export function buildDebug(): Plugin[] {
  const started = new Map<string, number>();
  let phase = 'not started';
  let timer: ReturnType<typeof setInterval> | undefined;

  function log(message: string) {
    console.log(`[build-debug] ${new Date().toISOString()} ${message}`);
  }

  function heartbeat() {
    const now = Date.now();
    const waiting = [...started].sort((a, b) => a[1] - b[1]).slice(0, 15);
    log(`phase=${phase} in flight=${started.size}`);
    for (const [id, since] of waiting) log(`  ${Math.round((now - since) / 1000)}s ${id}`);
  }

  return [
    {
      name: 'livething:build-debug-start',
      apply: 'build',
      enforce: 'pre',
      buildStart() {
        phase = 'buildStart';
        log(`build started (${this.environment?.name ?? 'unknown'})`);
        timer ??= setInterval(heartbeat, HEARTBEAT_MS);
      },
      load(id) {
        phase = 'transform';
        if (!started.has(id)) started.set(id, Date.now());

        return null;
      },
      buildEnd(error) {
        phase = 'buildEnd';
        log(`build ended${error ? ` with ${error.message}` : ''}`);
      },
      renderStart() {
        phase = 'renderStart';
      },
      generateBundle() {
        phase = 'generateBundle';
      },
      closeBundle() {
        phase = 'closeBundle';
        clearInterval(timer);
        timer = undefined;
        started.clear();
      },
    },
    {
      name: 'livething:build-debug-end',
      apply: 'build',
      enforce: 'post',
      transform(_code, id) {
        const since = started.get(id);
        if (since === undefined) return null;

        started.delete(id);
        const took = Date.now() - since;
        if (took > SLOW_MS) log(`slow ${Math.round(took / 1000)}s ${id}`);

        return null;
      },
    },
  ];
}
