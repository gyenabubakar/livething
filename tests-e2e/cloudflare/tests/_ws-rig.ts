import type { Page } from '@playwright/test';

/**
 * Shared raw-WebSocket rig used by tests that need direct wire access
 * (subscribing to channels, sending control frames, dropping the socket,
 * resuming streams). Each spec installs the rig onto a Playwright Page,
 * then talks to one or more sockets by id.
 */

export type WireFrame = {
  event: string;
  payload: Record<string, unknown>;
  __wskit?: Record<string, unknown>;
};

interface RigWindow {
  __wskitConnect?: (
    path: string,
    username: string,
    room: string,
  ) => Promise<{ id: string; frames: WireFrame[] }>;
  __wskitSend?: (id: string, frame: WireFrame) => void;
  __wskitSendBinary?: (id: string, bytes: number[]) => void;
  __wskitClose?: (id: string) => void;
  __wskitFrames?: (id: string) => WireFrame[];
}

declare global {
  interface Window extends RigWindow {}
}

export async function installRig(page: Page) {
  await page.evaluate(() => {
    const sockets = new Map<string, WebSocket>();
    const frames = new Map<string, WireFrame[]>();
    let nextId = 1;

    window.__wskitConnect = (path, username, room) => {
      const id = `s${nextId++}`;
      const url = `${location.origin.replace(/^http/, 'ws')}${path}?room=${encodeURIComponent(
        room,
      )}&username=${encodeURIComponent(username)}`;
      const ws = new WebSocket(url);
      sockets.set(id, ws);
      frames.set(id, []);
      ws.addEventListener('message', (ev) => {
        if (typeof ev.data === 'string') {
          try {
            frames.get(id)!.push(JSON.parse(ev.data));
          } catch {
            // ignore
          }
        }
      });
      return new Promise((resolve, reject) => {
        ws.addEventListener('open', () => resolve({ id, frames: frames.get(id)! }));
        ws.addEventListener('error', () => reject(new Error('ws error')));
      });
    };
    window.__wskitSend = (id, frame) => sockets.get(id)?.send(JSON.stringify(frame));
    window.__wskitSendBinary = (id, bytes) => sockets.get(id)?.send(new Uint8Array(bytes));
    window.__wskitClose = (id) => sockets.get(id)?.close();
    window.__wskitFrames = (id) => frames.get(id) ?? [];
  });
}

export interface ConnectOptions {
  path: string;
  username: string;
  room: string;
}

export async function connect(page: Page, opts: ConnectOptions): Promise<string> {
  return page.evaluate(([p, u, r]) => window.__wskitConnect!(p, u, r).then((res) => res.id), [
    opts.path,
    opts.username,
    opts.room,
  ] as const);
}

export async function send(page: Page, id: string, frame: WireFrame) {
  await page.evaluate(([sid, f]) => window.__wskitSend!(sid, f as WireFrame), [id, frame] as const);
}

export async function sendBinary(page: Page, id: string, bytes: number[]) {
  await page.evaluate(([sid, b]) => window.__wskitSendBinary!(sid, b as number[]), [
    id,
    bytes,
  ] as const);
}

export async function closeSocket(page: Page, id: string) {
  await page.evaluate((sid) => window.__wskitClose!(sid), id);
}

export async function frames(page: Page, id: string): Promise<WireFrame[]> {
  return page.evaluate((sid) => window.__wskitFrames!(sid), id);
}

export interface WaitForFrameOptions {
  match: (f: WireFrame) => boolean;
  timeoutMs?: number;
}

export async function waitForFrame(
  page: Page,
  id: string,
  opts: WaitForFrameOptions,
): Promise<WireFrame> {
  const { match, timeoutMs = 15000 } = opts;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const all = await frames(page, id);
    const hit = all.find(match);
    if (hit) return hit;
    await page.waitForTimeout(50);
  }
  throw new Error('frame not received in time');
}
