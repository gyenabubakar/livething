import { expect, test } from '@playwright/test';

test.describe('ctx-sql', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    const room = `test-${testInfo.testId}`;
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
});
