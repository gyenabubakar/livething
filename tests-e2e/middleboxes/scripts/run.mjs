// Runs the middlebox lane: makes the certificates, starts the Huddle server on the host, then
// starts each compose profile in turn, runs the specs through it, and stops it. Each step has a
// time limit, so a stuck proxy fails the lane instead of hanging it.
//
//   node scripts/run.mjs                   # every middlebox
//   node scripts/run.mjs nginx squid       # only these
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const all = ['direct', 'nginx', 'toxiproxy', 'mitmproxy', 'squid'];
const chosen = process.argv.slice(2).length > 0 ? process.argv.slice(2) : all;
const env = { ...process.env, NODE_EXTRA_CA_CERTS: `${root}certs/ca.crt` };

function run(command, args, { timeoutMs = 600_000, extraEnv = {} } = {}) {
  try {
    execFileSync(command, args, {
      cwd: root,
      stdio: 'inherit',
      timeout: timeoutMs,
      env: { ...env, ...extraEnv },
    });
    return true;
  } catch {
    return false;
  }
}

function compose(...args) {
  return run('docker', ['compose', ...args], { timeoutMs: 900_000 });
}

async function startServer() {
  const server = spawn(process.execPath, ['--experimental-strip-types', 'src/server.ts'], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('the server did not start in 30 seconds')),
      30_000,
    );
    server.stdout.on('data', (chunk) => {
      process.stdout.write(chunk);
      if (String(chunk).includes('middlebox server on')) {
        clearTimeout(timer);
        resolve();
      }
    });
    server.on('exit', (code) => reject(new Error(`the server exited with ${code}`)));
  });
  return server;
}

async function addToxiproxy() {
  for (let attempt = 0; attempt < 30; attempt++) {
    const response = await fetch('http://127.0.0.1:8474/proxies', {
      method: 'POST',
      body: JSON.stringify({
        name: 'livething',
        listen: '0.0.0.0:9445',
        upstream: 'host.docker.internal:8443',
      }),
    }).catch(() => null);
    if (response?.ok || response?.status === 409) return;

    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error('toxiproxy did not answer');
}

run(process.execPath, ['scripts/certs.mjs']);
const server = await startServer();
const results = {};
try {
  for (const middlebox of chosen) {
    if (
      middlebox !== 'direct' &&
      !compose('--profile', middlebox, 'up', '-d', '--build', '--wait')
    ) {
      results[middlebox] = 'did not start';
      continue;
    }

    if (middlebox === 'toxiproxy') await addToxiproxy();
    results[middlebox] = run('pnpm', ['exec', 'playwright', 'test'], {
      extraEnv: { LIVETHING_MIDDLEBOX: middlebox },
    })
      ? 'passed'
      : 'failed';
    if (middlebox !== 'direct') compose('--profile', middlebox, 'down');
  }
} finally {
  server.kill('SIGTERM');
}

console.log('\nmiddlebox lane:');
for (const [middlebox, result] of Object.entries(results)) {
  console.log(`  ${middlebox.padEnd(10)} ${result}`);
}

process.exit(Object.values(results).every((result) => result === 'passed') ? 0 : 1);
