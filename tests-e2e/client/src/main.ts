import {
  buffering,
  client,
  connect,
  keepalive,
  platform,
  reconnection,
  serialization,
} from '@wskit/client';
import { WebEnvironment } from '@wskit/client/environment';
import * as errorsEntry from '@wskit/client/errors';
import * as platformEntry from '@wskit/client/platform';
import * as testingEntry from '@wskit/client/testing';
import type { Primitive, Socket } from '@wskit/client';

// The page imports the BUILT client (dist via the package exports), so loading
// and connecting at all is itself the bundle smoke test. The extra subpath
// imports below prove every published entry point resolves in a browser too.
const subpathsOk = [errorsEntry, platformEntry, testingEntry].every(
  (mod) => Object.keys(mod).length > 0,
);

interface Contract {
  incoming: { echoed: { text?: string }; 'bin-echo': { bytes: number[] } };
  outgoing: { hello: { text: string }; drop: Record<string, never> };
}

const params = new URLSearchParams(location.search);
const path = params.get('path') ?? 'echo';
const room = params.get('room') ?? 'default';
const useKeepalive = params.get('keepalive') === '1';
const usePlatform = params.get('platform') === '1';
const useReconnect = params.get('reconnect') === '1' || usePlatform;
const useBinary = params.get('binary') === '1';
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
if (useBuffering) primitives.push(buffering({ enabled: true }));
if (useBinary) {
  primitives.push(
    serialization({
      binaryType: 'arraybuffer',
      // The puppet server echoes the raw bytes; decode them back into a frame.
      parseBinary: (data) => ({
        event: 'bin-echo',
        payload: { bytes: Array.from(new Uint8Array(data)) },
      }),
    }),
  );
}
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
  ...(idleMs ? { idleTimeout: Number(idleMs) } : {}),
};

// The primitive set is chosen at runtime from query params, so it can't be the
// const tuple client()'s inference wants. We only ever use base Socket methods
// here, so build with the primitives applied and read it back as Socket.
const socket = client<Contract>()(
  connect(url, connectOptions),
  ...(primitives as unknown as []),
) as Socket<Contract>;

function el(id: string): HTMLElement {
  return document.querySelector(`[data-testid="${id}"]`) as HTMLElement;
}

let openCount = 0;

function render(): void {
  el('state').textContent = socket.getState();
  el('quality').textContent = socket.getQuality();
  const latency = socket.getLatency();
  el('latency').textContent = latency === null ? '' : String(latency);
  el('open-count').textContent = String(openCount);
}

socket.subscribe(render);
socket.onQualityChange(render);
socket.onOpen(() => {
  openCount += 1;
  render();
});

// on() takes a lazy hold and would open a lazy socket on sight, which would
// defeat the lazy test — so only the non-lazy pages register message handlers.
if (!useLazy) {
  socket.on('echoed', (payload) => {
    el('last-event').textContent = 'echoed';
    el('last-payload').textContent = JSON.stringify(payload);
  });
  socket.on('bin-echo', (payload) => {
    el('binary-echo').textContent = payload.bytes.join(',');
  });
}

(window as unknown as { __drop(): void }).__drop = () => socket.send('drop', {});

el('connect').addEventListener('click', () => socket.connect());
el('disconnect').addEventListener('click', () => socket.disconnect());
el('send-hello').addEventListener('click', () => socket.send('hello', { text: 'hi' }));
el('send-binary').addEventListener('click', () =>
  socket.sendBinary(new Uint8Array([1, 2, 3, 4]).buffer),
);

el('subpaths-ok').textContent = subpathsOk ? 'yes' : 'no';
el('app-ready').textContent = 'yes';
render();
