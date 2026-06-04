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

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      ws.send(data, { binary: true });
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
    if (behavior === 'pong') {
      if (frame.event === 'ping') ws.send(JSON.stringify({ event: 'pong', payload: {} }));
      return;
    }
    // echo: bounce the payload back under a fixed event name.
    ws.send(JSON.stringify({ event: 'echoed', payload: frame.payload }));
  });
});

httpServer.listen(PORT, '127.0.0.1', () => {
  console.log(`[ws-fixture] listening on ${PORT}`);
});
