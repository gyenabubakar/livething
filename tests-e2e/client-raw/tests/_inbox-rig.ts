import { expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';

// Shared raw-wire helpers for the inbox-family specs (inbox, receipts,
// inbox-gap). Each opens one member per browser context, collects that socket's
// frames onto window.__frames, and drives the durable inbox/receipts wire
// protocol directly via window.__ws — no SDK. The single-socket route pages only
// connect and expose window.__ws; all protocol work happens here.

export type Frame = {
  event: string;
  payload: Record<string, unknown>;
  __wskit?: Record<string, unknown>;
};

// Each route page owns its own frame buffer on window.__frames, filled from the
// socket's onmessage before onopen can race the drain. It is reset to [] on every
// (re)connect, so a poll after a reconnect only sees that connection's frames.

export interface Member {
  page: Page;
  close: () => Promise<void>;
}

export interface OpenOptions {
  path: string;
  room: string;
  username: string;
}

export async function openMember(browser: Browser, opts: OpenOptions): Promise<Member> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${opts.path}?room=${opts.room}`);
  await page.getByTestId('username').fill(opts.username);
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('status')).toHaveText('connected');
  return { page, close: () => ctx.close() };
}

export async function frames(page: Page): Promise<Frame[]> {
  return page.evaluate(() => (window as unknown as { __frames?: Frame[] }).__frames ?? []);
}

export async function waitForFrame(page: Page, match: (f: Frame) => boolean): Promise<Frame> {
  await expect.poll(async () => (await frames(page)).some(match), { timeout: 15_000 }).toBe(true);
  return (await frames(page)).find(match)!;
}

export async function send(page: Page, frame: Frame): Promise<void> {
  await page.evaluate((f) => {
    (window as unknown as { __ws?: WebSocket }).__ws?.send(JSON.stringify(f));
  }, frame);
}

export async function subscribe(page: Page): Promise<Frame> {
  await send(page, { event: '__subscribe__', payload: {}, __wskit: { channel: 'chat' } });
  return waitForFrame(page, (f) => f.event === '__subscribeOk__' && f.__wskit?.channel === 'chat');
}

export async function closeSocket(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __ws?: WebSocket }).__ws?.close();
  });
  await expect(page.getByTestId('status')).toHaveText('disconnected');
}

export async function reconnect(page: Page): Promise<void> {
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('status')).toHaveText('connected');
}
