// Runs every benchmark the docs publish, several rounds in a new order each round, and writes the
// medians to one file.
//
//   node bench/run-all.mjs [suite...]
//
// Suites: core (the Server Benchmarks tables), chat and features. The default is all three.
// Every run uses `load.mjs`, so its environment variables work here too: set LOAD_SERVER to run
// the servers on another machine.
//
//   BENCH_ROUNDS       rounds of every run (default 5)
//   BENCH_CONNECTIONS  clients in each run (default 2000)
//   BENCH_OUT          the folder for the results (default bench-results/<date and time>)
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const loadScript = fileURLToPath(new URL('./load.mjs', import.meta.url));
const rounds = Number(process.env.BENCH_ROUNDS ?? 5);
if (!Number.isSafeInteger(rounds) || rounds < 1) {
  throw new Error('BENCH_ROUNDS must be a whole number of at least 1.');
}

const connections = Number(process.env.BENCH_CONNECTIONS ?? 2000);
const outDir =
  process.env.BENCH_OUT ?? join('bench-results', new Date().toISOString().replaceAll(':', '-'));

const SUITES = ['core', 'chat', 'features'];
const suites = process.argv.length > 2 ? process.argv.slice(2) : SUITES;
for (const suite of suites) {
  if (!SUITES.includes(suite)) throw new Error(`Unknown suite ${suite}. Use ${SUITES.join(', ')}.`);
}

// The chat's busy hour measures reply times, so its clients need more than one process.
const chatClients = { LOAD_CLIENT_PROCESSES: process.env.LOAD_CLIENT_PROCESSES ?? '4' };
// The same checks as `load.mjs`, so a bad value stops here, not in every run.
const clientProcesses = Number(
  suites.some((suite) => suite !== 'core')
    ? chatClients.LOAD_CLIENT_PROCESSES
    : (process.env.LOAD_CLIENT_PROCESSES ?? 1),
);
if (!Number.isSafeInteger(clientProcesses) || clientProcesses < 1) {
  throw new Error('LOAD_CLIENT_PROCESSES must be a whole number of at least 1.');
}

// Every run would write its profiles under the same step names, each over the last.
if (process.env.LOAD_PROFILE) {
  throw new Error('run-all does not take LOAD_PROFILE. To profile, run bench/load.mjs on its own.');
}

if (
  !Number.isSafeInteger(connections) ||
  connections <= 0 ||
  connections % 10 !== 0 ||
  connections % clientProcesses !== 0
) {
  throw new Error(
    `BENCH_CONNECTIONS must be a positive multiple of 10 that ${clientProcesses} client ` +
      'processes (LOAD_CLIENT_PROCESSES) divide evenly.',
  );
}

const presenceOff = { LOAD_PRESENCE: 'off' };

const RUNS = {
  core: [
    { name: 'livething', mode: 'livething', env: presenceOff },
    { name: 'livething, presence on', mode: 'livething', env: { LOAD_STEPS: 'join' } },
    { name: 'ws', mode: 'ws' },
    { name: 'socket.io', mode: 'socket.io' },
    { name: 'livething-http', mode: 'livething-http', env: presenceOff },
    {
      name: 'livething-http-stream',
      mode: 'livething-http-stream',
      env: { ...presenceOff, LOAD_H2_ENTRY: 'stream' },
    },
    { name: 'socket.io-polling', mode: 'socket.io-polling' },
  ],
  chat: [
    { name: 'chat: livething', mode: 'livething', env: { ...presenceOff, ...chatClients } },
    { name: 'chat: ws', mode: 'ws', env: chatClients },
    { name: 'chat: socket.io', mode: 'socket.io', env: chatClients },
    {
      name: 'chat: livething-http',
      mode: 'livething-http',
      env: { ...presenceOff, ...chatClients },
    },
    { name: 'chat: socket.io-polling', mode: 'socket.io-polling', env: chatClients },
    {
      name: 'chat: livething, replay',
      mode: 'livething',
      env: { ...presenceOff, ...chatClients, LOAD_REPLAY: 'on' },
    },
  ],
  features: [
    { name: 'features: livething', mode: 'livething', env: chatClients },
    { name: 'features: livething-http', mode: 'livething-http', env: chatClients },
  ],
};

function shuffled(list) {
  const copy = [...list];
  for (let index = copy.length - 1; index > 0; index--) {
    const other = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[other]] = [copy[other], copy[index]];
  }

  return copy;
}

// Each run sets these itself, so one left in this shell must not change every run.
const RUN_SETTINGS = [
  'LOAD_SUITE',
  'LOAD_STEPS',
  'LOAD_WARM',
  'LOAD_PRESENCE',
  'LOAD_H2_ENTRY',
  'LOAD_REPLAY',
  'LOAD_DEDUP',
  'LOAD_RATE_LIMIT',
];
const baseEnv = { ...process.env };
for (const name of RUN_SETTINGS) delete baseEnv[name];

/** One `load.mjs` run's report, or null when it failed. */
function runOnce(run, warm) {
  const env = {
    ...baseEnv,
    LOAD_SUITE: run.suite,
    ...run.env,
    ...(warm ? { LOAD_WARM: 'on' } : {}),
  };

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [loadScript, run.mode, String(connections)], {
      env,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let stdout = '';
    let settled = false;
    function failed(why) {
      // A child that could not start sends `error`, then `close` too.
      if (settled) return;

      settled = true;
      console.error(`${run.name} (${warm ? 'warm' : 'cold'}) ${why}. Going on.`);
      process.exitCode = 1;
      resolve(null);
    }

    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.once('error', (error) => failed(`did not start: ${error.message}`));
    // `close`, not `exit`: it comes after stdout has been read to the end.
    child.once('close', (code) => {
      if (code !== 0) {
        failed(`exited with code ${code}`);
        return;
      }

      try {
        resolve(JSON.parse(stdout.trim().split('\n').at(-1)));
      } catch {
        failed('printed no report');
      }
    });
  });
}

function median(values) {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const plan = suites.flatMap((suite) =>
  RUNS[suite].flatMap((entry) => [
    { run: { ...entry, suite }, warm: false },
    { run: { ...entry, suite }, warm: true },
  ]),
);
function keyOf(entry) {
  return `${entry.run.name} | ${entry.warm ? 'warmed up' : 'cold start'}`;
}

// In the order of the plan, so two summaries compare line by line.
const reports = new Map(plan.map((entry) => [keyOf(entry), []]));

mkdirSync(outDir, { recursive: true });
const rawFile = join(outDir, 'runs.jsonl');
const summaryFile = join(outDir, 'summary.json');
// The summary holds only this run's reports, so the raw file must too.
writeFileSync(rawFile, '');

/**
 * For each run and step, the median of every number in its rows, and how many units one CPU core
 * handles per second: one second divided by the median CPU time of one unit.
 */
function writeSummary() {
  const summary = {};
  for (const [key, runReports] of reports) {
    if (runReports.length === 0) continue;

    const steps = {};
    for (const { step } of runReports[0].results) {
      const rows = runReports.map((report) => report.results.find((one) => one.step === step));
      const medians = { runs: rows.length };
      for (const [field, value] of Object.entries(rows[0])) {
        if (typeof value !== 'number') continue;

        medians[field] = Number(median(rows.map((one) => one[field])).toFixed(3));
      }

      steps[step] = { perSecondOnOneCore: Math.round(1e6 / medians.cpuUsPerUnit), ...medians };
    }

    summary[key] = steps;
  }

  writeFileSync(summaryFile, `${JSON.stringify(summary, null, 2)}\n`);
}

for (let round = 1; round <= rounds; round++) {
  for (const entry of shuffled(plan)) {
    console.log(`round ${round} of ${rounds}: ${keyOf(entry)}`);
    const report = await runOnce(entry.run, entry.warm);
    if (!report) continue;

    appendFileSync(rawFile, `${JSON.stringify({ round, key: keyOf(entry), ...report })}\n`);
    reports.get(keyOf(entry)).push(report);
  }

  // After each round, so a run that stops halfway still leaves its medians.
  writeSummary();
}

console.log(`Done. The medians are in ${summaryFile}, every run in ${rawFile}.`);
