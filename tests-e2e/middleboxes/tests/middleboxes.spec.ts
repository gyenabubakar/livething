import { chromium, expect, test } from '@playwright/test';
import type { Browser, LaunchOptions, Page } from '@playwright/test';

// One middlebox runs at a time: the lane script starts its compose profile and sets
// LIVETHING_MIDDLEBOX. Each case says how the browser reaches the server through it, and what
// the path allows: WebSocket or not, and stream mode or only batch mode.
interface Path {
  origin: string;
  proxy?: string;
  websocket: boolean;
  streamMode: boolean;
  /** `false` for a proxy that holds a whole response until it ends, so no SSE event gets through. */
  sse?: false;
}

const SERVER = 'https://livething.test:8443';

const paths: Record<string, Path> = {
  direct: { origin: SERVER, websocket: true, streamMode: true },
  'nginx-tuned': { origin: 'https://livething.test:9443', websocket: true, streamMode: true },
  'nginx-stock': { origin: 'https://livething.test:9444', websocket: false, streamMode: false },
  toxiproxy: { origin: 'https://livething.test:9445', websocket: true, streamMode: true },
  'mitmproxy-stock': {
    origin: SERVER,
    proxy: 'http://127.0.0.1:8080',
    websocket: true,
    streamMode: false,
    sse: false,
  },
  'mitmproxy-streaming': {
    origin: SERVER,
    proxy: 'http://127.0.0.1:8081',
    websocket: true,
    streamMode: true,
  },
  squid: { origin: SERVER, proxy: 'http://127.0.0.1:3128', websocket: false, streamMode: false },
};

const middlebox = process.env.LIVETHING_MIDDLEBOX ?? 'direct';
const selected = Object.entries(paths).filter(([name]) => name.startsWith(middlebox));

interface Stats {
  streamPosts: number;
  batchPosts: number;
  streamRequests: number;
}

async function serverStats(): Promise<Stats> {
  const response = await fetch(`https://127.0.0.1:8443/stats`);
  return (await response.json()) as Stats;
}

async function open(path: Path): Promise<{ browser: Browser; page: Page }> {
  const options: LaunchOptions = path.proxy
    ? { proxy: { server: path.proxy } }
    : { args: ['--host-resolver-rules=MAP livething.test 127.0.0.1'] };
  const browser = await chromium.launch(options);
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  await page.goto(`${path.origin}/`);

  await page.waitForFunction(() => 'runHuddle' in window);

  return { browser, page };
}

interface Run {
  transport: string;
  inOrder: boolean;
  echoed: number;
  binaryOk: boolean;
  broadcastOk: boolean;
  openMs: number;
  totalMs: number;
}

for (const [name, path] of selected) {
  test.describe(`through ${name}`, () => {
    test.beforeEach(async () => {
      await fetch('https://127.0.0.1:8443/stats/reset');
    });

    test('websocket() then http(): messages, bytes and broadcasts arrive', async () => {
      const { browser, page } = await open(path);
      try {
        const run = (await page.evaluate(() =>
          (window as unknown as { runHuddle(): Promise<unknown> }).runHuddle(),
        )) as Run;
        test.info().annotations.push({ type: 'result', description: JSON.stringify(run) });

        expect(run.transport).toBe(path.websocket ? 'websocket' : 'http');
        expect(run).toMatchObject({ inOrder: true, echoed: 50, binaryOk: true, broadcastOk: true });
      } finally {
        await browser.close();
      }
    });

    test('http() alone: no event gets through a proxy that holds whole responses', async () => {
      test.skip(path.sse !== false, 'this path passes the stream on');

      const { browser, page } = await open(path);
      try {
        const opening = page.evaluate(() =>
          (window as unknown as { runHuddle(options: unknown): Promise<unknown> }).runHuddle({
            transports: ['http'],
          }),
        );

        await expect(opening).rejects.toThrow('timed out: open ada');
        expect((await serverStats()).streamRequests).toBeGreaterThan(0);
      } finally {
        await browser.close();
      }
    });

    test('http() alone: the client uses stream mode only where the path streams', async () => {
      test.skip(path.sse === false, 'no event gets through this path');

      const { browser, page } = await open(path);
      try {
        const run = (await page.evaluate(() =>
          (window as unknown as { runHuddle(options: unknown): Promise<unknown> }).runHuddle({
            transports: ['http'],
          }),
        )) as Run;
        const stats = await serverStats();
        test
          .info()
          .annotations.push({ type: 'result', description: JSON.stringify({ run, stats }) });

        expect(run.transport).toBe('http');
        expect(run).toMatchObject({ inOrder: true, echoed: 50, binaryOk: true, broadcastOk: true });
        if (path.streamMode) expect(stats.streamPosts).toBeGreaterThan(0);
        else expect(stats.batchPosts).toBeGreaterThan(0);
      } finally {
        await browser.close();
      }
    });

    test('http() alone: a long POST carries more than 1 MiB and stays in stream mode', async () => {
      test.skip(!path.streamMode, 'this path has no stream mode');

      const { browser, page } = await open(path);
      try {
        const run = (await page.evaluate(() =>
          (window as unknown as { runBigStream(): Promise<unknown> }).runBigStream(),
        )) as {
          echoed: number;
          inOrder: boolean;
          batchPostsDuring: number;
          streamPostsBefore: number;
        };
        test.info().annotations.push({ type: 'result', description: JSON.stringify(run) });

        expect(run.streamPostsBefore).toBeGreaterThan(0);
        expect(run).toMatchObject({ echoed: 40, inOrder: true, batchPostsDuring: 0 });
      } finally {
        await browser.close();
      }
    });
  });
}

test.describe('through toxiproxy, while it cuts every connection', () => {
  test.skip(middlebox !== 'toxiproxy', 'needs the toxiproxy profile');

  for (const transports of [['websocket', 'http'], ['http']]) {
    test(`${transports.join(' then ')}: no message runs twice or out of order`, async () => {
      const { browser, page } = await open(paths.toxiproxy!);
      try {
        const running = page.evaluate(
          (list) =>
            (
              window as unknown as { runThroughDrops(options: unknown): Promise<unknown> }
            ).runThroughDrops({ transports: list }),
          transports,
        );
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        await toggleToxiproxy(false);
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        await toggleToxiproxy(true);

        const { opens, echoed, refused } = (await running) as {
          opens: string[];
          echoed: number[];
          refused: number[];
        };
        test.info().annotations.push({
          type: 'result',
          description: JSON.stringify({ opens, echoed: echoed.length, refused: refused.length }),
        });

        expect(opens.length).toBeGreaterThanOrEqual(2);
        expect(new Set(echoed).size).toBe(echoed.length);
        expect(echoed).toEqual([...echoed].sort((a, b) => a - b));
        expect(echoed.at(-1)).toBe(60);
      } finally {
        await browser.close();
      }
    });
  }
});

async function toggleToxiproxy(enabled: boolean): Promise<void> {
  const response = await fetch('http://127.0.0.1:8474/proxies/livething', {
    method: 'POST',
    body: JSON.stringify({ enabled }),
  });
  expect(response.ok).toBe(true);
}
