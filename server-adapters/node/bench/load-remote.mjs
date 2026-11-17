// Runs on the server machine when the clients run on another one. It waits for `load.mjs` with
// LOAD_SERVER=<this machine's private IP> and starts `load-server.mjs` for each run, as `load.mjs`
// does on one machine, then passes the run's messages to it over HTTP.
//
//   node bench/load-remote.mjs <private IP>
//
// It listens on that IP (default 127.0.0.1), on LOAD_CONTROL_PORT (default 9100), and the server
// listens on LOAD_PORT (default 9101), so the client machine needs only those two. A client picks
// only the server mode and the settings below. Node flags for the server come from this
// machine's own LOAD_SERVER_FLAGS, never from the client. It runs one server at a time, and stops
// a server that hears nothing for 5 minutes, as when its `load.mjs` was stopped.
import { fork } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const host = process.argv[2] ?? '127.0.0.1';
const controlPort = Number(process.env.LOAD_CONTROL_PORT ?? 9100);
const serverScript = fileURLToPath(new URL('./load-server.mjs', import.meta.url));
const serverFlags = process.env.LOAD_SERVER_FLAGS?.split(' ').filter(Boolean) ?? [];
const MODES = new Set([
  'livething',
  'livething-http',
  'livething-http-h2',
  'livething-http-stream',
  'ws',
  'socket.io',
  'socket.io-polling',
]);
/** The settings `load-server.mjs` reads. */
const SETTINGS = new Set([
  'LOAD_SUITE',
  'LOAD_REPLAY',
  'LOAD_DEDUP',
  'LOAD_RATE_LIMIT',
  'LOAD_PRESENCE',
  'LOAD_H2_ENTRY',
]);
let server = null;

/** The next message the server sends back, or an error when it exits first. */
function reply(child) {
  return new Promise((resolve, reject) => {
    function exited(code) {
      reject(new Error(`the server exited with code ${code}`));
    }

    child.once('exit', exited);
    child.once('message', (message) => {
      child.off('exit', exited);
      resolve(message);
    });
  });
}

// A run calls for the stats between its steps. A server that hears nothing for this long belongs
// to a client that was stopped, so it is stopped too.
const IDLE_MS = 5 * 60_000;
let idleTimer;

function startServer(mode, env) {
  if (!MODES.has(mode)) throw new Error(`Unknown mode ${mode}.`);

  if (server) throw new Error('Another run is using the server. Wait for it to end.');

  // Only the client's settings: one it leaves out must not come from this machine.
  const serverEnv = { ...process.env, LOAD_HOST: host, LOAD_PORT: process.env.LOAD_PORT ?? '9101' };
  for (const name of SETTINGS) {
    delete serverEnv[name];
    if (env?.[name] !== undefined) serverEnv[name] = String(env[name]);
  }

  const child = fork(serverScript, [mode], {
    execArgv: ['--expose-gc', ...serverFlags],
    env: serverEnv,
  });
  child.once('exit', () => {
    if (server === child) server = null;
  });
  server = child;

  return reply(child);
}

async function control(request) {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => server?.kill(), IDLE_MS);

  if (request.start) return startServer(request.start.mode, request.start.env);

  if (!server?.connected) throw new Error('No server is running. It ended, or was never started.');

  if (request.message === 'exit') {
    const exited = new Promise((resolve) => server.once('exit', resolve));
    server.send('exit');
    await exited;
    return {};
  }

  // A profile message names a file to write, so a client can only ask for the stats.
  if (request.message !== 'stats') throw new Error('Only the stats can be read from a client.');

  const answer = reply(server);
  server.send('stats');

  return answer;
}

http
  .createServer(async (request, response) => {
    // A client that resets mid-request must not stop this process and its server.
    request.on('error', () => {});
    try {
      let body = '';
      for await (const chunk of request) body += chunk;

      const answer = JSON.stringify((await control(JSON.parse(body))) ?? null);
      if (!response.destroyed) response.end(answer);
    } catch (error) {
      if (response.destroyed) return;

      response.statusCode = 500;
      response.end(JSON.stringify({ error: error.message }));
    }
  })
  .listen(controlPort, host, () => {
    console.error(`load-remote is waiting for load.mjs on ${host}:${controlPort}`);
  });

process.on('exit', () => server?.kill());
