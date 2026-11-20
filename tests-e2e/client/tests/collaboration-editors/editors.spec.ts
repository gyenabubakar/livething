import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';

// Real editors on a shared Huddle board, bound through `board.yjs`: the doc for the text, and
// the y-protocols awareness for live cursors. Rich text editors edit a task's notes; text
// editors edit the board title.
const EDITORS = {
  prosemirror: { content: '.ProseMirror', richText: true },
  tiptap: { content: '.ProseMirror', richText: true },
  codemirror: { content: '.cm-content', richText: false },
  quill: { content: '.ql-editor', richText: false },
  monaco: { content: '.monaco-editor .view-lines', richText: false },
} as const;

/**
 * Click into the editor and type. y-prosemirror redraws the cursors when the caret moves, and
 * keys typed during that redraw are lost, so with a rich text editor the typing waits until
 * the binding has published the new caret and the page has drawn a frame.
 */
async function typeInto(page: Page, editor: keyof typeof EDITORS, text: string): Promise<void> {
  const before = await page.getByTestId('own-cursor').textContent();
  await page.locator(`[data-testid="editor"] ${EDITORS[editor].content}`).click();
  if (EDITORS[editor].richText) {
    await expect(page.getByTestId('own-cursor')).not.toHaveText(before ?? '');
    await page.waitForFunction(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  }

  await page.keyboard.type(text);
}

async function openEditor(
  browser: Browser,
  { room, username, editor }: { room: string; username: string; editor: keyof typeof EDITORS },
  setup?: (page: Page) => Promise<void>,
): Promise<Page> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(
    `/tests/collaboration-editors/index.html?room=${room}&username=${username}&editor=${editor}`,
  );
  await expect(page.getByTestId('app-ready')).toHaveText('yes');
  await page.getByTestId('connect').click();

  await page.getByTestId('open').click();
  await expect(page.getByTestId('status')).toHaveText('synced');
  await setup?.(page);
  await page.getByTestId('mount').click();
  await expect(page.getByTestId('editor')).toHaveAttribute('data-mounted', 'yes');

  return page;
}

for (const [editor, { richText }] of Object.entries(EDITORS) as [
  keyof typeof EDITORS,
  (typeof EDITORS)[keyof typeof EDITORS],
][]) {
  test(`${editor}: two members type in one ${richText ? 'rich text' : 'text'} field and see each other's cursor`, async ({
    browser,
  }, testInfo) => {
    const room = `editors-${testInfo.testId}`;
    // A rich text editor edits the first task's notes, so the first member adds the task.
    const alice = await openEditor(browser, { room, username: 'alice', editor }, async (page) => {
      if (!richText) return;

      await page.getByTestId('add-task').click();
    });
    const bob = await openEditor(browser, { room, username: 'bob', editor });

    await typeInto(alice, editor, 'Hello');
    await expect(bob.getByTestId('text')).toHaveText('Hello');
    await expect(bob.getByTestId('remote-cursors')).toHaveText('alice');

    await typeInto(bob, editor, 'Team ');
    await expect(alice.getByTestId('text')).toContainText('Hello');
    await expect(alice.getByTestId('text')).toContainText('Team');
    await expect(alice.getByTestId('remote-cursors')).toHaveText('bob');

    await expect(alice.getByTestId('refused')).toHaveText('');
    await expect(bob.getByTestId('refused')).toHaveText('');
    if (editor === 'prosemirror') {
      await expect(bob.locator('.ProseMirror-yjs-cursor')).toHaveCount(1);
    }
  });
}
