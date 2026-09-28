import type { Page } from '@playwright/test';

/**
 * Shared raw-WebSocket rig used by tests that need direct wire access
 * (subscribing to channels, sending control frames, dropping the socket,
 * continuing streams). Each spec installs the rig onto a Playwright Page,
 * then talks to one or more sockets by id.
 */

export type WireFrame = {
  event: string;
  payload: Record<string, unknown>;
  metadata?: Record<string, Record<string, unknown>> | null;
};

type WireInput = Omit<WireFrame, 'payload'> & { payload: Record<string, unknown> | null };
type RawWireFrame = [string, unknown, Record<string, Record<string, unknown>> | null];

interface RigWindow {
  __livethingConnect?: (
    path: string,
    username: string,
    room: string,
  ) => Promise<{ id: string; frames: WireFrame[] }>;
  __livethingSend?: (id: string, frame: WireInput) => void;
  __livethingSendRaw?: (id: string, text: string) => void;
  __livethingClose?: (id: string) => void;
  __livethingFrames?: (id: string) => WireFrame[];
  __livethingRawFrames?: (id: string) => string[];
}

declare global {
  interface Window extends RigWindow {}
}

export async function installRig(page: Page) {
  await page.evaluate(() => {
    const sockets = new Map<string, WebSocket>();
    const socketFrames = new Map<string, WireFrame[]>();
    const rawSocketFrames = new Map<string, string[]>();
    let nextId = 1;

    function encode(frame: WireInput): RawWireFrame {
      const metadata =
        frame.metadata && Object.keys(frame.metadata).length > 0 ? frame.metadata : null;
      return [frame.event, frame.payload ?? null, metadata];
    }

    function decode(value: unknown): WireFrame {
      if (!Array.isArray(value) || value.length !== 3 || typeof value[0] !== 'string') {
        throw new Error('invalid LiveThing wire frame');
      }

      if (value[2] !== null && (typeof value[2] !== 'object' || Array.isArray(value[2]))) {
        throw new Error('invalid LiveThing metadata');
      }

      return {
        event: value[0],
        payload: (value[1] as Record<string, unknown> | null) ?? {},
        metadata: (value[2] as Record<string, Record<string, unknown>> | null) ?? null,
      };
    }

    window.__livethingConnect = (path, username, room) => {
      const id = `s${nextId++}`;
      const url = `${location.origin.replace(/^http/, 'ws')}${path}?room=${encodeURIComponent(
        room,
      )}&username=${encodeURIComponent(username)}`;
      const ws = new WebSocket(url);
      sockets.set(id, ws);
      socketFrames.set(id, []);

      rawSocketFrames.set(id, []);
      ws.addEventListener('message', (ev) => {
        if (typeof ev.data === 'string') {
          rawSocketFrames.get(id)!.push(ev.data);
          try {
            socketFrames.get(id)!.push(decode(JSON.parse(ev.data)));
          } catch {
            // A bare `ping` / `pong` is not JSON; it lives in rawSocketFrames only.
          }
        }
      });

      return new Promise((resolve, reject) => {
        ws.addEventListener('open', () => resolve({ id, frames: socketFrames.get(id)! }));
        ws.addEventListener('error', () => reject(new Error('ws error')));
      });
    };
    window.__livethingSend = (id, frame) => sockets.get(id)?.send(JSON.stringify(encode(frame)));
    window.__livethingSendRaw = (id, text) => sockets.get(id)?.send(text);
    window.__livethingClose = (id) => sockets.get(id)?.close();
    window.__livethingFrames = (id) => socketFrames.get(id) ?? [];

    window.__livethingRawFrames = (id) => rawSocketFrames.get(id) ?? [];
  });
}

export interface ConnectOptions {
  path: string;
  username: string;
  room: string;
}

export async function connect(page: Page, opts: ConnectOptions): Promise<string> {
  return page.evaluate(([p, u, r]) => window.__livethingConnect!(p, u, r).then((res) => res.id), [
    opts.path,
    opts.username,
    opts.room,
  ] as const);
}

export async function send(page: Page, id: string, frame: WireInput) {
  await page.evaluate(([sid, f]) => window.__livethingSend!(sid, f as WireInput), [
    id,
    frame,
  ] as const);
}

/** Send one bare text frame, bypassing JSON — used for `ping` and `pong`. */
export async function sendRaw(page: Page, id: string, text: string) {
  await page.evaluate(([sid, value]) => window.__livethingSendRaw!(sid, value), [
    id,
    text,
  ] as const);
}

export async function closeSocket(page: Page, id: string) {
  await page.evaluate((sid) => window.__livethingClose!(sid), id);
}

export async function frames(page: Page, id: string): Promise<WireFrame[]> {
  return page.evaluate((sid) => window.__livethingFrames!(sid), id);
}

/** Every text frame the socket received, including the non-JSON `ping` / `pong`. */
export async function rawFrames(page: Page, id: string): Promise<string[]> {
  return page.evaluate((sid) => window.__livethingRawFrames!(sid), id);
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
