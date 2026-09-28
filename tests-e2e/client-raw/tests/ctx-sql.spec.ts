import { expect, test } from '@playwright/test';

test.describe('ctx-sql', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    const room = `test-${testInfo.testId}-${Date.now()}`;
    await page.goto(`/ctx-sql?room=${room}`);
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');
  });

  test('save and retrieve notes', async ({ page }) => {
    await page.getByTestId('save-note').click();
    await expect(page.getByTestId('note-titles')).toContainText('Test Note');
  });

  test('save then get notes separately', async ({ page }) => {
    await page.getByTestId('save-note').click();
    await expect(page.getByTestId('note-titles')).toContainText('Test Note');
    await page.getByTestId('get-notes').click();
    await expect(page.getByTestId('note-titles')).toContainText('Test Note');
  });

  test('SqlResult.one returns a single row', async ({ page }) => {
    await page.getByTestId('save-note').click();
    await expect(page.getByTestId('note-titles')).toContainText('Test Note');
    await page.getByTestId('sql-one').click();
    await expect(page.getByTestId('one-count')).toHaveText(/[1-9]\d*/);
  });

  test('SqlResult.raw returns array-of-arrays rows', async ({ page }) => {
    await page.getByTestId('save-note').click();
    await expect(page.getByTestId('note-titles')).toContainText('Test Note');
    await page.getByTestId('sql-raw').click();
    // Expect a JSON like [[1,"Test Note"], ...] — starts with [[ and contains the title.
    await expect(page.getByTestId('raw-rows')).toContainText(/^\[\[/);
    await expect(page.getByTestId('raw-rows')).toContainText('Test Note');
  });

  test('exec with parameter binding (?) correctly inserts and retrieves', async ({ page }) => {
    await page.getByTestId('save-note').click();
    // Note: handler uses INSERT INTO notes (title, body) VALUES (?, ?)
    // so if binding is broken, the title would be the literal '?' or undefined
    await expect(page.getByTestId('note-titles')).toContainText('Test Note');
    // Verify the exact title was inserted (not a placeholder)
    const titles = await page.getByTestId('note-titles').textContent();
    expect(titles).toBe('Test Note');
  });

  test('SqlResult throws when a second method is called on the same result', async ({ page }) => {
    await page.getByTestId('save-note').click();
    await expect(page.getByTestId('note-titles')).toContainText('Test Note');
    await page.getByTestId('sql-reuse').click();
    await expect(page.getByTestId('reuse-error')).toContainText('already consumed by .one()');
  });

  test('SqlResult.one returns null when no rows match', async ({ page }) => {
    // Seed with one row first so the page has a definitive signal that
    // events are round-tripping. Then fire the no-match probe and follow
    // with a positive probe — once the positive probe's response lands, we
    // know the no-match frame has also been processed.
    await page.getByTestId('save-note').click();
    await expect(page.getByTestId('note-titles')).toContainText('Test Note');

    await page.getByTestId('sql-one-empty').click();
    await page.getByTestId('sql-one').click();
    await expect(page.getByTestId('one-count')).toHaveText(/[1-9]\d*/);

    // No-match probe must have resolved by now; its count cell stays empty.
    await expect(page.getByTestId('one-empty-count')).toHaveText('');
  });

  test('sql.transaction commits all statements atomically', async ({ page }) => {
    await page.getByTestId('sql-tx-commit').click();
    await expect(page.getByTestId('note-titles')).toContainText('tx-a');
    await expect(page.getByTestId('note-titles')).toContainText('tx-b');
  });

  test('sql.transaction rolls back every statement when the callback throws', async ({ page }) => {
    await page.getByTestId('sql-tx-rollback').click();
    // A follow-up save round-trips a fresh notes-list; once its title lands we
    // know the rollback frame has been processed, so the absence below is real.
    await page.getByTestId('save-note').click();
    await expect(page.getByTestId('note-titles')).toContainText('Test Note');
    await expect(page.getByTestId('note-titles')).not.toContainText('tx-rollback');
  });

  test('sql.one() throws when the query returns more than one row', async ({ page }) => {
    await page.getByTestId('sql-one-multi').click();
    // A non-empty error string proves one() threw on the multi-row result.
    await expect(page.getByTestId('reuse-error')).toHaveText(/.+/);
  });

  test('getConnections() returns a full connection snapshot', async ({ page }) => {
    await page.getByTestId('connections-snapshot').click();
    await expect(page.getByTestId('snapshot-shape-ok')).toHaveText('true');
    await expect(page.getByTestId('snapshot-count')).toHaveText(/[1-9]\d*/);
  });
});
