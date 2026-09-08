import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  archiveWorkingReports,
  clearWorkingReports,
  getAuditState,
  getSuccessfulPaths,
  lighthouseDirectory,
} = require('./lighthouse-state.cjs');

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} exited with ${code}`));
    });
  });
}

async function collectWithProgress(state) {
  let displayedDone = state.completed;
  const printProgress = () => {
    archiveWorkingReports();
    const done = state.completed + getSuccessfulPaths(lighthouseDirectory).size;
    if (done <= displayedDone) return;

    displayedDone = done;
    console.log(
      `Lighthouse progress: ${done}/${state.total} done; ${state.total - done} remaining.`,
    );
  };

  const progressTimer = setInterval(printProgress, 1000);
  try {
    await run('pnpm', ['exec', 'lhci', 'collect', '--config', './lighthouserc.cjs']);
  } finally {
    clearInterval(progressTimer);
    printProgress();
  }
}

if (process.env.LIGHTHOUSE_FORCE === '1') {
  await run('pnpm', ['run', 'generate']);
}

archiveWorkingReports();
clearWorkingReports();

const config = require('../lighthouserc.cjs');
const state = getAuditState({
  force: process.env.LIGHTHOUSE_FORCE === '1',
  routeLimit: Number(process.env.LIGHTHOUSE_ROUTE_LIMIT || 0),
});

if (config.ci.collect.url.length > 0) {
  await collectWithProgress(state);
} else {
  console.log('Every sitemap route already has a successful Lighthouse report.');
}

await run('pnpm', ['exec', 'lhci', 'upload', '--config', './lighthouserc.cjs']);
await run(process.execPath, ['./scripts/summarize-lighthouse.mjs']);
