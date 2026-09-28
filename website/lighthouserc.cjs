const { getAuditState } = require('./scripts/lighthouse-state.cjs');

const port = 4173;
const state = getAuditState({
  force: process.env.LIGHTHOUSE_FORCE === '1',
  routeLimit: Number(process.env.LIGHTHOUSE_ROUTE_LIMIT || 0),
});

console.log(
  `Lighthouse progress: ${state.completed}/${state.total} done; ${state.pending} remaining.`,
);
if (state.missing > 0)
  console.log(`${state.missing} sitemap route is missing from the generated site.`);

module.exports = {
  ci: {
    collect: {
      numberOfRuns: 1,
      startServerCommand: `PORT=${port} node scripts/serve-generated.mjs`,
      startServerReadyPattern: 'Lighthouse preview ready',
      startServerReadyTimeout: 30_000,
      url: state.urls,
    },
    upload: {
      outputDir: '.lighthouseci/reports',
      target: 'filesystem',
    },
  },
};
