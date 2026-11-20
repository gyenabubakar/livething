import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';

// Conformance: @livething/plugin-collaboration's client against the real server definition.
// Members of a Huddle room edit the room's launch task board. Each page renders the board's
// stores, and each button makes one edit. Usernames that start with `guest` may only view.
/** Who opens the board: a member of `room`, with the board kept on the device when `device`. */
interface Member {
  readonly room: string;
  readonly username: string;
  readonly device?: boolean;
}

async function openMember(browser: Browser, member: Member): Promise<Page> {
  const { room, username, device = false } = member;
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(
    `/tests/collaboration/index.html?room=${room}&username=${username}${device ? '&device=1' : ''}`,
  );
  await join(page);

  return page;
}

async function join(page: Page): Promise<void> {
  await expect(page.getByTestId('app-ready')).toHaveText('yes');
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('connection')).toHaveText('open');
  await page.getByTestId('open').click();
  await expect(page.getByTestId('status')).toHaveText('synced');
}

async function rename(page: Page, title: string): Promise<void> {
  await page.getByTestId('title-input').fill(title);
  await page.getByTestId('rename').click();
}

/** Drop the socket from the server. The page reconnects about 2 s later. */
async function dropSocket(page: Page): Promise<void> {
  await page.getByTestId('server-drop').click();
  await expect(page.getByTestId('status')).toHaveText('offline');
}

test.describe('collaboration', () => {
  test('two members edit the board at once, and both see both edits', async ({
    browser,
  }, testInfo) => {
    const room = `collab-${testInfo.testId}`;
    const alice = await openMember(browser, { room, username: 'alice' });
    const bob = await openMember(browser, { room, username: 'bob' });

    await rename(alice, 'Launch plan');
    await bob.getByTestId('add-task').click();

    for (const page of [alice, bob]) {
      await expect(page.getByTestId('title')).toHaveText('Launch plan');
      await expect(page.getByTestId('tasks')).toHaveText('t1-bob');
      await expect(page.getByTestId('status')).toHaveText('synced');
    }
  });

  test('an edit made offline merges with the others once the socket is back', async ({
    browser,
  }, testInfo) => {
    const room = `collab-${testInfo.testId}`;
    const alice = await openMember(browser, { room, username: 'alice' });
    const bob = await openMember(browser, { room, username: 'bob' });

    await dropSocket(alice);
    await rename(alice, 'Written offline');
    await bob.getByTestId('add-task').click();

    for (const page of [alice, bob]) {
      await expect(page.getByTestId('status')).toHaveText('synced', { timeout: 10_000 });
      await expect(page.getByTestId('title')).toHaveText('Written offline');
      await expect(page.getByTestId('tasks')).toHaveText('t1-bob');
    }
  });

  test('two members move tasks at once, and every task stays once', async ({
    browser,
  }, testInfo) => {
    const room = `collab-${testInfo.testId}`;
    const alice = await openMember(browser, { room, username: 'alice' });
    const bob = await openMember(browser, { room, username: 'bob' });
    for (let i = 0; i < 3; i += 1) await alice.getByTestId('add-task').click();
    await expect(bob.getByTestId('tasks')).toHaveText('t1-alice,t2-alice,t3-alice');

    await Promise.all([
      alice.getByTestId('move-first-to-end').click(),
      bob.getByTestId('move-first-to-end').click(),
    ]);

    await expect(alice.getByTestId('status')).toHaveText('synced');
    await expect(bob.getByTestId('status')).toHaveText('synced');
    const tasks = await alice.getByTestId('tasks').textContent();
    await expect(bob.getByTestId('tasks')).toHaveText(tasks!);
    expect(tasks!.split(',').sort()).toEqual(['t1-alice', 't2-alice', 't3-alice']);
  });

  test('the server refuses a bad edit and undoes it on every page', async ({
    browser,
  }, testInfo) => {
    const room = `collab-${testInfo.testId}`;
    const alice = await openMember(browser, { room, username: 'alice' });
    const bob = await openMember(browser, { room, username: 'bob' });
    await alice.getByTestId('add-task').click();
    await expect(bob.getByTestId('tasks')).toHaveText('t1-alice');

    await alice.getByTestId('bad-edit').click();

    await expect(alice.getByTestId('refused')).toContainText('done: ');
    await expect(alice.getByTestId('status')).toHaveText('synced');
    await expect(alice.getByTestId('tasks')).toHaveText('t1-alice');
    await expect(bob.getByTestId('tasks')).toHaveText('t1-alice');
  });

  test("a 'view' member reads the board but cannot change it", async ({ browser }, testInfo) => {
    const room = `collab-${testInfo.testId}`;
    const alice = await openMember(browser, { room, username: 'alice' });
    await rename(alice, 'Launch');
    const guest = await openMember(browser, { room, username: 'guest' });

    await expect(guest.getByTestId('access')).toHaveText('view');
    await expect(guest.getByTestId('title')).toHaveText('Launch');
    await rename(guest, 'Hijacked');

    await expect(guest.getByTestId('errors')).toHaveText('read-only');
    await expect(alice.getByTestId('title')).toHaveText('Launch');
  });

  test('a member saves a version and restores it for everyone, and undo takes it back', async ({
    browser,
  }, testInfo) => {
    const room = `collab-${testInfo.testId}`;
    const alice = await openMember(browser, { room, username: 'alice' });
    const bob = await openMember(browser, { room, username: 'bob' });
    const guest = await openMember(browser, { room, username: 'guest' });

    await rename(alice, 'Draft');
    await alice.getByTestId('save-version').click();
    await expect(alice.getByTestId('versions')).toHaveText('Saved as Draft=alice');
    await rename(bob, 'Final');
    await expect(alice.getByTestId('title')).toHaveText('Final');

    await alice.getByTestId('restore-oldest-version').click();

    await expect(alice.getByTestId('version-title')).toHaveText('Draft');
    for (const page of [alice, bob, guest]) {
      await expect(page.getByTestId('title')).toHaveText('Draft');
    }

    await alice.getByTestId('undo').click();
    await expect(bob.getByTestId('title')).toHaveText('Final');
    await guest.getByTestId('save-version').click();
    await expect(guest.getByTestId('errors')).toHaveText('access-denied');
  });

  test('members see where the others are, and one member at a time holds a lock', async ({
    browser,
  }, testInfo) => {
    const room = `collab-${testInfo.testId}`;
    const alice = await openMember(browser, { room, username: 'alice' });
    const bob = await openMember(browser, { room, username: 'bob' });
    await alice.getByTestId('add-task').click();
    await expect(bob.getByTestId('tasks')).toHaveText('t1-alice');

    await alice.getByTestId('view-first').click();
    await expect(bob.getByTestId('viewers')).toHaveText('alice=t1-alice');

    await alice.getByTestId('lock-first').click();
    await expect(alice.getByTestId('lock-result')).toHaveText('true');
    await expect(bob.getByTestId('locks')).toHaveText('task:t1-alice=alice');
    await bob.getByTestId('lock-first').click();
    await expect(bob.getByTestId('lock-result')).toHaveText('false');

    await alice.getByTestId('close').click();
    await expect(bob.getByTestId('locks')).toHaveText('');
    await bob.getByTestId('lock-first').click();
    await expect(bob.getByTestId('lock-result')).toHaveText('true');
  });

  test('an anchor follows its words when another member edits the text', async ({
    browser,
  }, testInfo) => {
    const room = `collab-${testInfo.testId}`;
    const alice = await openMember(browser, { room, username: 'alice' });
    const bob = await openMember(browser, { room, username: 'bob' });
    await alice.getByTestId('add-task').click();
    await expect(bob.getByTestId('tasks')).toHaveText('t1-alice');

    await alice.getByTestId('anchor-first').click();
    await expect(alice.getByTestId('anchor')).toHaveText('0-2');
    await bob.getByTestId('prefix-first-task').click();

    await expect(alice.getByTestId('anchor')).toHaveText('4-6');
  });

  test('a change the server makes reaches every member', async ({ browser }, testInfo) => {
    const room = `collab-${testInfo.testId}`;
    const alice = await openMember(browser, { room, username: 'alice' });
    const bob = await openMember(browser, { room, username: 'bob' });

    await alice.getByTestId('archive').click();

    await expect(alice.getByTestId('archived')).toHaveText('true');
    await expect(bob.getByTestId('archived')).toHaveText('true');
  });

  test('a board bigger than one stored row is stored, and loads back once unloaded', async ({
    browser,
  }, testInfo) => {
    const room = `collab-${testInfo.testId}`;
    const alice = await openMember(browser, { room, username: 'alice' });
    const bob = await openMember(browser, { room, username: 'bob' });

    await alice.getByTestId('big-title').click();
    await expect(bob.getByTestId('title-length')).toHaveText('3000000', { timeout: 20_000 });
    await expect(alice.getByTestId('status')).toHaveText('synced', { timeout: 20_000 });

    // With every member gone the server unloads the board; the next member loads it back.
    await alice.getByTestId('close').click();
    await bob.getByTestId('close').click();
    await expect(bob.getByTestId('status')).toHaveText('closed');
    const carol = await openMember(browser, { room, username: 'carol' });
    await expect(carol.getByTestId('title-length')).toHaveText('3000000', { timeout: 20_000 });
  });

  test('an edit made offline survives a reload, and reaches the others later', async ({
    browser,
  }, testInfo) => {
    const room = `collab-${testInfo.testId}`;
    const alice = await openMember(browser, { room, username: 'alice', device: true });
    const bob = await openMember(browser, { room, username: 'bob' });

    await dropSocket(alice);
    await rename(alice, 'Kept on the device');
    await expect(alice.getByTestId('title')).toHaveText('Kept on the device');
    // The device write is async; give it a moment before the reload.
    await alice.waitForTimeout(200);
    await alice.reload();
    await join(alice);

    await expect(alice.getByTestId('title')).toHaveText('Kept on the device');
    await expect(bob.getByTestId('title')).toHaveText('Kept on the device');
  });
});
