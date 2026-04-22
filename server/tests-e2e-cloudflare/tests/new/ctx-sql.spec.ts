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

  test('SqlResult.one returns null when no rows match', async ({ page }) => {
    await page.getByTestId('sql-one-empty').click();
    // Query with WHERE id = -999 (no match), one() should return null
    // When row is null, display should be empty
    const count = await page.getByTestId('one-empty-count').textContent();
    expect(count).toBe('');
  });
});
