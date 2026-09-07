// Puppet WebSocket server for the client e2e harness. It is NOT the wskit
// server — it speaks no contract. Each connection's behaviour is chosen by the
// last path segment, so a test points the client at the behaviour it needs and
// asserts on what the client does. A small /__count endpoint reports how many
// sockets a room has seen, which is how tests confirm a reconnect really opened
// a new socket.
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

const PORT = 8788;

/** room -> number of sockets opened against it */
const counts = new Map();

const httpServer = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  if (url.pathname === '/__count') {
    const room = url.searchParams.get('room') ?? 'default';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ count: counts.get(room) ?? 0 }));
    return;
  }

  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  const behavior = url.pathname.split('/').filter(Boolean).pop() ?? 'echo';
  const room = url.searchParams.get('room') ?? 'default';
  const nth = (counts.get(room) ?? 0) + 1;
  counts.set(room, nth);

  // Drop only the first socket of the room; the reconnect stays open.
  if (behavior === 'drop-once') {
    if (nth === 1) setTimeout(() => ws.terminate(), 150);
    return;
  }

  // accept: stay open, say nothing. silent: same, used to starve keepalive.
  if (behavior === 'accept' || behavior === 'silent') return;

  // server-ping: act like the wskit server keepalive — send a bare "ping" text
  // frame and expect the client to auto-reply with a bare "pong" (the only pong
  // form the real server records, see server messages.ts: `data === 'pong'`).
  // On a correct raw pong, send back an `echoed` frame so the test can see the
  // round-trip completed. A JSON pong, or no pong at all, yields nothing.
  if (behavior === 'server-ping') {
    ws.on('message', (data) => {
      if (data.toString() === 'pong') {
        ws.send(JSON.stringify({ event: 'echoed', payload: { text: 'pong-confirmed' } }));
      }
    });
    ws.send('ping');
    return;
  }

  // Simulate a newer server sending an unsolicited error code this client was
  // not built with. This fixture intentionally bypasses WSKit's server engine;
  // a normal server would normalize an undeclared thrown error to internal-error.
  if (behavior === 'unknown-server-error') {
    ws.on('message', (data) => {
      let frame;
      try {
        frame = JSON.parse(data.toString());
      } catch {
        return;
      }

      if (frame.event === 'hello') {
        ws.send(
          JSON.stringify({
            event: '__error__',
            payload: { code: 'newer-server-error', detail: { future: true, source: 'server-v2' } },
          }),
        );
      }
    });
    return;
  }

  if (behavior === 'unknown-plugin-server-error') {
    ws.on('message', (data) => {
      let frame;
      try {
        frame = JSON.parse(data.toString());
      } catch {
        return;
      }

      if (frame.event === '__future:plugin::trigger-plugin-error') {
        ws.send(
          JSON.stringify({
            event: '__error__',
            payload: {
              code: '__future:plugin::plugin-future-error',
              detail: { future: true, version: 2 },
            },
          }),
        );
      }
    });
    return;
  }

  ws.on('message', (data) => {
    // Keepalive: the wskit client sends a bare "ping" text frame (raw, so the
    // CF hibernation auto-response can answer it). The `pong` behavior answers
    // with a bare "pong", mirroring the real server; others ignore it.
    if (data.toString() === 'ping') {
      if (behavior === 'pong') ws.send('pong');
      return;
    }

    let frame;
    try {
      frame = JSON.parse(data.toString());
    } catch {
      return;
    }

    // drop-on-demand: terminate when the client asks, so a test controls the
    // exact moment the socket dies (no timing races).
    if (frame.event === 'drop') {
      ws.terminate();
      return;
    }

    // pong server only answers pings — never echoes app frames.
    if (behavior === 'pong') return;

    // echo: bounce the payload back under a fixed event name.
    ws.send(JSON.stringify({ event: 'echoed', payload: frame.payload }));
  });
});

httpServer.listen(PORT, '127.0.0.1', () => {
  console.log(`[ws-fixture] listening on ${PORT}`);
});
