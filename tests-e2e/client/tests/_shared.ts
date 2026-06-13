// Helpers shared by every conformance feature page. Each feature module builds
// its own buttons and result spans, then wires @wskit/client against the real
// server reached over the same-origin /ws proxy.

// Build the WebSocket URL for a feature's route. `room` and `username` come from
// the page's own query string so a spec can isolate each test on its own room
// (one durable object) and identity. The URL is origin-relative — vite proxies
// /ws to whichever adapter the run booted.
export function wsUrl(feature: string): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const page = new URLSearchParams(location.search);
  const qs = new URLSearchParams({
    room: page.get('room') ?? 'default',
    username: page.get('username') ?? 'alice',
  }).toString();
  return `${scheme}://${location.host}/ws/${feature}?${qs}`;
}

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

// The code on a WSKitError (request/ack rejection, error frames), or '' if the
// thrown value isn't one.
export function errorCode(err: unknown): string {
  return err && typeof err === 'object' && 'code' in err
    ? String((err as { code: unknown }).code)
    : '';
}
