import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const reportsDirectory = resolve('.lighthouse-results');
const summaryDirectory = resolve('.lighthouse-results');

async function findJsonFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const entryPath = `${directory}/${entry.name}`;
      return entry.isDirectory()
        ? findJsonFiles(entryPath)
        : entry.isFile() && entry.name.endsWith('.json')
          ? [entryPath]
          : [];
    }),
  );
  return files.flat();
}

const reports = [];
for (const file of await findJsonFiles(reportsDirectory)) {
  const report = JSON.parse(await readFile(file, 'utf8'));
  if (report.audits && report.categories && report.finalDisplayedUrl) reports.push(report);
}

if (reports.length === 0) {
  throw new Error(`No Lighthouse reports found in ${reportsDirectory}`);
}

const byUrl = new Map();
for (const report of reports) {
  const existing = byUrl.get(report.finalDisplayedUrl);
  if (!existing || report.fetchTime > existing.fetchTime)
    byUrl.set(report.finalDisplayedUrl, report);
}

const uniqueReports = [...byUrl.values()].sort((a, b) =>
  a.finalDisplayedUrl.localeCompare(b.finalDisplayedUrl),
);
const categorySummaries = new Map();
const failedAudits = new Map();

for (const report of uniqueReports) {
  for (const [id, category] of Object.entries(report.categories)) {
    const summary = categorySummaries.get(id) || { id, title: category.title, scores: [] };
    summary.scores.push(category.score * 100);
    categorySummaries.set(id, summary);
  }

  for (const [id, audit] of Object.entries(report.audits)) {
    if (
      !['binary', 'numeric'].includes(audit.scoreDisplayMode) ||
      audit.score === null ||
      audit.score === 1
    )
      continue;

    const issue = failedAudits.get(id) || {
      id,
      title: audit.title,
      description: audit.description,
      pages: [],
      worstScore: 1,
    };
    issue.pages.push({ url: report.finalDisplayedUrl, displayValue: audit.displayValue || '' });
    issue.worstScore = Math.min(issue.worstScore, audit.score);
    failedAudits.set(id, issue);
  }
}

const categories = [...categorySummaries.values()]
  .map((category) => ({
    ...category,
    average: category.scores.reduce((total, score) => total + score, 0) / category.scores.length,
    lowest: Math.min(...category.scores),
  }))
  .sort((a, b) => a.title.localeCompare(b.title));
const issues = [...failedAudits.values()].sort(
  (a, b) =>
    b.pages.length - a.pages.length || a.worstScore - b.worstScore || a.id.localeCompare(b.id),
);

const markdown = [
  '# Lighthouse documentation audit',
  '',
  `Audited ${uniqueReports.length} routes locally at ${new Date().toISOString()}.`,
  '',
  '## Category scores',
  '',
  '| Category | Average | Lowest |',
  '| --- | ---: | ---: |',
  ...categories.map(
    (category) =>
      `| ${category.title} | ${category.average.toFixed(0)} | ${category.lowest.toFixed(0)} |`,
  ),
  '',
  '## Failing audits',
  '',
  '| Audit | Affected pages | Worst score |',
  '| --- | ---: | ---: |',
  ...issues.map(
    (issue) =>
      `| ${issue.title} (${issue.id}) | ${issue.pages.length} | ${(issue.worstScore * 100).toFixed(0)} |`,
  ),
  '',
  'See `summary.json` for every affected route and its Lighthouse display value.',
  '',
].join('\n');

await writeFile(
  `${summaryDirectory}/summary.json`,
  `${JSON.stringify({ categories, issues }, null, 2)}\n`,
);
await writeFile(`${summaryDirectory}/summary.md`, markdown);

console.log(`Summarized ${uniqueReports.length} routes and ${issues.length} failing audits.`);
