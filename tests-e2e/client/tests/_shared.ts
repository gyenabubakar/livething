// Helpers shared by every conformance feature page. Each feature module builds
// its own buttons and result spans, then wires @livething/client against the real
// server reached over the same-origin /ws proxy.

// Build the WebSocket URL for a feature's route. `room` and `username` come from
// the page's own query string so a spec can isolate each test on its own room
// (one durable object) and identity. The URL is origin-relative — vite proxies
// /ws to whichever adapter the run booted.
//
// The Node test server shuts a room down 1 s after its last socket closes, the
// way Cloudflare evicts an idle Durable Object. `holdRoom` keeps the room's
// server running across a socket drop, for specs about a server that stays up.
export function wsUrl(feature: string, options: { holdRoom?: boolean } = {}): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const page = new URLSearchParams(location.search);
  const room = page.get('room') ?? 'default';
  const qs = new URLSearchParams({ room, username: page.get('username') ?? 'alice' });
  if (options.holdRoom) qs.set('__livethingFixtureLease', room);

  return `${scheme}://${location.host}/ws/${feature}?${qs.toString()}`;
}

// maxDelay for pages whose specs act while the client is offline after a drop.
// The first retry then waits 1.4 to 2.6 s, long enough to see 'reconnecting'
// and to act before the socket is back, even on a slow machine.
export const OFFLINE_WINDOW_MAX_DELAY = 2000;

// Render the feature's markup into the shell's mount point.
export function mount(html: string): void {
  const app = document.querySelector('#app');
  if (app) app.innerHTML = html;
}

export function el(id: string): HTMLElement {
  return document.querySelector(`[data-testid="${id}"]`) as HTMLElement;
}

// Wire a button by test id. The handler may be async; failures are swallowed so
// a rejected promise never becomes an unhandled rejection — feature pages record
// outcomes in the DOM instead.
export function button(id: string, onClick: () => void | Promise<void>): void {
  el(id).addEventListener('click', () => {
    void Promise.resolve(onClick()).catch(() => {});
  });
}

// The signal a spec waits on before driving the page — the module finished
// building its DOM and wiring the socket.
export function ready(): void {
  const span = document.createElement('span');
  span.dataset.testid = 'app-ready';
  span.textContent = 'yes';
  document.body.appendChild(span);
}

// The code on a LiveThingError (request/ack rejection, error frames), or '' if the
// thrown value isn't one.
export function errorCode(err: unknown): string {
  return err && typeof err === 'object' && 'code' in err
    ? String((err as { code: unknown }).code)
    : '';
}
