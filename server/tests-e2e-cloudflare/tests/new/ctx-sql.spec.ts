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
});
