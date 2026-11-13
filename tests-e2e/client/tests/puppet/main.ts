import {
  buffering,
  client,
  connect,
  keepalive,
  platform,
  plugin,
  reconnection,
} from '@livething/client';
import { WebEnvironment } from '@livething/client/environment';
import * as errorsEntry from '@livething/client/errors';
import * as platformEntry from '@livething/client/platform';
import * as testingEntry from '@livething/client/testing';
import type { Primitive, QualityApi, Socket } from '@livething/client';

// The page imports the BUILT client (dist via the package exports), so loading
// and connecting at all is itself the bundle smoke test. The extra subpath
// imports below prove every published entry point resolves in a browser too.
const subpathsOk = [errorsEntry, platformEntry, testingEntry].every(
  (mod) => Object.keys(mod).length > 0,
);

interface Contract {
  errors: {
    '__future:plugin::known-error': { version: number };
  };
  incoming: { echoed: { text?: string } };
  outgoing: {
    hello: { text: string };
    drop: Record<string, never>;
    '__future:plugin::trigger-plugin-error': Record<string, never>;
  };
}

interface FuturePluginWire {
  errors: { 'known-error': { version: number } };
  outgoing: { 'trigger-plugin-error': Record<string, never> };
}

interface FuturePluginApi {
  triggerError(): void;
  onFutureError(callback: (code: string, detail: unknown) => void): void;
}

const FuturePlugin = plugin<FuturePluginWire, FuturePluginApi>()({
  id: 'future:plugin',
  setup(socket) {
    const errorCallbacks = new Set<(code: string, detail: unknown) => void>();
    socket.onServerError((error) => {
      errorCallbacks.forEach((callback) => callback(error.code, error.detail));
    });
    return {
      api: () => ({
        triggerError: () => void socket.send('trigger-plugin-error', {}),
        onFutureError: (callback) => void errorCallbacks.add(callback),
      }),
    };
  },
});

const params = new URLSearchParams(location.search);
const path = params.get('path') ?? 'echo';
const room = params.get('room') ?? 'default';
const useKeepalive = params.get('keepalive') === '1';
const usePlatform = params.get('platform') === '1';
const useReconnect = params.get('reconnect') === '1' || usePlatform;
const useBuffering = params.get('buffering') === '1';
const useLazy = params.get('lazy') === '1';
const idleMs = params.get('idleMs');
const bgMs = params.get('bgMs');

// Let the test drive tab visibility. WebEnvironment reads document.visibilityState
// inside its handler, so shadowing the getter and firing the event is enough.
let visibility: DocumentVisibilityState = 'visible';
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
(window as unknown as { __setVisibility(v: DocumentVisibilityState): void }).__setVisibility = (
  v,
) => {
  visibility = v;
  document.dispatchEvent(new Event('visibilitychange'));
};

// Drive the real network signal WebEnvironment listens to. CDP offline
// emulation ignores loopback, so we fire the actual window events instead.
(window as unknown as { __setOnline(online: boolean): void }).__setOnline = (online) => {
  window.dispatchEvent(new Event(online ? 'online' : 'offline'));
};

const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
const url = `${scheme}://${location.host}/wsx/${path}?room=${encodeURIComponent(room)}`;

const primitives: Primitive[] = [];
if (useReconnect) primitives.push(reconnection({ networkAware: usePlatform, maxDelay: 500 }));
if (useKeepalive) primitives.push(keepalive({ interval: 100, maxMissedPongs: 2 }));
if (useBuffering) primitives.push(buffering());
if (usePlatform) {
  primitives.push(
    platform({
      environment: WebEnvironment,
      ...(bgMs ? { backgroundDisconnectMs: Number(bgMs) } : {}),
    }),
  );
}

const connectOptions = {
  lazy: useLazy,
  ...(idleMs ? { lazyIdleTimeoutMs: Number(idleMs) } : {}),
};

// The primitive set is chosen at runtime from query params, so it can't be the
// const tuple client()'s inference wants. We only ever use base Socket methods
// here, so build with the primitives applied and read it back as Socket.
// keepalive (and so the quality API) is only present on some pages, so the
// quality and latency stores are optional here.
const socket = client<Contract>()(
  connect(url, connectOptions),
  FuturePlugin(),
  ...(primitives as unknown as []),
) as Socket<Contract> & Partial<QualityApi>;

function el(id: string): HTMLElement {
  return document.querySelector(`[data-testid="${id}"]`) as HTMLElement;
}

const futurePlugin = FuturePlugin.use(socket);

let openCount = 0;

function render(): void {
  el('state').textContent = socket.state.get();
  el('quality').textContent = socket.quality?.get() ?? '';
  const latency = socket.latency?.get() ?? null;
  el('latency').textContent = latency === null ? '' : String(latency);
  el('open-count').textContent = String(openCount);
}

socket.state.subscribe(render);
socket.quality?.subscribe(render);
socket.latency?.subscribe(render);
socket.onOpen(() => {
  openCount += 1;
  render();
});

socket.onServerError((error) => {
  el('server-error-code').textContent = error.code;
  el('server-error-detail').textContent = JSON.stringify(error.detail);
  if (error.code.startsWith('__future:plugin::')) {
    el('host-plugin-error-code').textContent = error.code;
  }
});
socket.onError(() => {
  el('local-error').textContent = 'called';
});
futurePlugin.onFutureError((code, detail) => {
  el('plugin-server-error-code').textContent = code;
  el('plugin-server-error-detail').textContent = JSON.stringify(detail);
});

// on() takes a lazy hold and would open a lazy socket on sight, which would
// defeat the lazy test — so only the non-lazy pages register message handlers.
if (!useLazy) {
  socket.on('echoed', (payload) => {
    el('last-event').textContent = 'echoed';
    el('last-payload').textContent = JSON.stringify(payload);
  });
}

(window as unknown as { __drop(): void }).__drop = () => socket.send('drop', {});
(window as unknown as { __disconnect(code: number, reason: string): void }).__disconnect = (
  code,
  reason,
) => socket.disconnect(code, reason);

el('connect').addEventListener('click', () => socket.connect());
el('disconnect').addEventListener('click', () => socket.disconnect());
el('send-hello').addEventListener('click', () => socket.send('hello', { text: 'hi' }));
el('send-plugin-error').addEventListener('click', () => futurePlugin.triggerError());

el('subpaths-ok').textContent = subpathsOk ? 'yes' : 'no';
el('server-error-code').textContent = '';
el('server-error-detail').textContent = '';
el('plugin-server-error-code').textContent = '';
el('plugin-server-error-detail').textContent = '';
el('host-plugin-error-code').textContent = '';
el('local-error').textContent = '';
el('app-ready').textContent = 'yes';
render();
