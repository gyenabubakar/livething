const fs = require('node:fs');
const path = require('node:path');

const websiteDirectory = path.resolve(__dirname, '..');
const lighthouseDirectory = path.join(websiteDirectory, '.lighthouseci');
const resultsDirectory = path.join(websiteDirectory, '.lighthouse-results');
const sitemapPath = path.join(websiteDirectory, '.output', 'public', 'sitemap.xml');

function getSuccessfulReports(directory) {
  if (!fs.existsSync(directory)) return [];

  const reports = [];
  for (const file of fs.readdirSync(directory)) {
    if (!/^lhr-.*\.json$/.test(file)) continue;

    try {
      const report = JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'));
      if (!report.runtimeError && report.finalDisplayedUrl) reports.push({ file, report });
    } catch {
      // Ignore a partial report left behind by an interrupted Lighthouse process.
    }
  }

  return reports;
}

function getSuccessfulPaths(directory) {
  return new Set(
    getSuccessfulReports(directory).map(({ report }) => new URL(report.finalDisplayedUrl).pathname),
  );
}

function archiveWorkingReports() {
  fs.mkdirSync(resultsDirectory, { recursive: true });

  for (const { file } of getSuccessfulReports(lighthouseDirectory)) {
    const source = path.join(lighthouseDirectory, file);
    const destination = path.join(resultsDirectory, file);
    if (!fs.existsSync(destination)) fs.copyFileSync(source, destination);
  }
}

function clearWorkingReports() {
  if (!fs.existsSync(lighthouseDirectory)) return;

  for (const file of fs.readdirSync(lighthouseDirectory)) {
    if (/^lhr-.*\.(?:html|json)$/.test(file)) fs.rmSync(path.join(lighthouseDirectory, file));
  }
}

function getAuditState({ force = false, routeLimit = 0 } = {}) {
  if (!fs.existsSync(sitemapPath)) {
    throw new Error(
      `No generated sitemap found at ${sitemapPath}. Run LIGHTHOUSE_FORCE=1 pnpm lighthouse.`,
    );
  }

  const sitemap = fs.readFileSync(sitemapPath, 'utf8');
  const allUrls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(([, loc]) => {
    const url = new URL(loc);
    return `http://127.0.0.1:4173${url.pathname}${url.search}`;
  });
  const publicDirectory = path.join(websiteDirectory, '.output', 'public');
  const generatedUrls = allUrls.filter((url) => {
    const pathname = new URL(url).pathname;
    const file = pathname === '/' ? 'index.html' : `${pathname.slice(1)}.html`;
    return fs.existsSync(path.join(publicDirectory, file));
  });
  const completedPaths = force ? new Set() : getSuccessfulPaths(resultsDirectory);
  const pendingUrls = generatedUrls.filter((url) => !completedPaths.has(new URL(url).pathname));

  return {
    completed: generatedUrls.length - pendingUrls.length,
    missing: allUrls.length - generatedUrls.length,
    pending: pendingUrls.length,
    total: generatedUrls.length,
    urls: routeLimit > 0 ? pendingUrls.slice(0, routeLimit) : pendingUrls,
  };
}

module.exports = {
  archiveWorkingReports,
  clearWorkingReports,
  getAuditState,
  getSuccessfulPaths,
  lighthouseDirectory,
  resultsDirectory,
};
