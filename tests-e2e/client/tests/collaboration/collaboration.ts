import {
  awareness,
  binary,
  channels,
  client,
  clientRequests,
  connect,
  reconnection,
} from '@livething/client';
import { collaboration, indexedDbStorage } from '@livething/plugin-collaboration/client';
import { huddleDocs } from '@livething/tests-e2e-handlers/collaboration/docs';
import type { CollaborationClient } from '@livething/tests-e2e-handlers/collaboration';
import type * as Y from 'yjs';
import {
  button,
  el,
  errorCode,
  mount,
  OFFLINE_WINDOW_MAX_DELAY,
  ready,
  wsUrl,
} from '../_shared.ts';

// Drives @livething/plugin-collaboration's client against the real server: Huddle's launch
// task board. Every store is rendered, and each button makes one edit, so a spec can act on
// one page and read the result on another. `?device=1` keeps the board in IndexedDB.
export function setup(): void {
  mount(`
    <button data-testid="connect">connect</button>
    <button data-testid="open">open</button>
    <button data-testid="close">close</button>
    <input data-testid="title-input" />
    <button data-testid="rename">rename</button>
    <button data-testid="add-task">add-task</button>
    <button data-testid="toggle-first">toggle-first</button>
    <button data-testid="move-first-to-end">move-first-to-end</button>
    <button data-testid="prefix-first-task">prefix-first-task</button>
    <button data-testid="undo">undo</button>
    <button data-testid="bad-edit">bad-edit</button>
    <button data-testid="big-title">big-title</button>
    <button data-testid="archive">archive</button>
    <button data-testid="view-first">view-first</button>
    <button data-testid="lock-first">lock-first</button>
    <button data-testid="unlock-first">unlock-first</button>
    <button data-testid="anchor-first">anchor-first</button>
    <button data-testid="server-drop">server-drop</button>
    <span data-testid="connection"></span>
    <span data-testid="status"></span>
    <span data-testid="access"></span>
    <span data-testid="title"></span>
    <span data-testid="title-length"></span>
    <span data-testid="tasks"></span>
    <span data-testid="archived"></span>
    <span data-testid="refused"></span>
    <span data-testid="errors"></span>
    <span data-testid="state-errors"></span>
    <span data-testid="viewers"></span>
    <span data-testid="locks"></span>
    <span data-testid="lock-result"></span>
    <span data-testid="anchor"></span>
  `);

  const page = new URLSearchParams(location.search);
  const room = page.get('room') ?? 'default';
  const username = page.get('username') ?? 'alice';
  const HuddleCollaboration = collaboration({
    docs: huddleDocs,
    closeDelayMs: 0,
    // Content past the schema (the bad-edit button) shows here, not as an uncaught error.
    onError: (error) => append('state-errors', errorCode(error)),
    ...(page.get('device') === '1'
      ? { storage: indexedDbStorage({ name: `huddle-${room}-${username}` }) }
      : {}),
  });

  const socket = client<CollaborationClient>()(
    connect(wsUrl('collaboration')),
    channels(),
    binary(),
    awareness(),
    clientRequests(),
    reconnection({ maxDelay: OFFLINE_WINDOW_MAX_DELAY }),
    HuddleCollaboration(),
  );
  const board = HuddleCollaboration.use(socket).doc('task-board', 'launch');

  function append(id: string, value: string): void {
    const prev = el(id).textContent;
    el(id).textContent = prev ? `${prev},${value}` : value;
  }

  function attempt(edit: () => void): void {
    try {
      edit();
    } catch (error) {
      append('errors', errorCode(error));
    }
  }

  socket.state.subscribe((state) => {
    el('connection').textContent = state;
  });
  board.status.subscribe((status) => {
    el('status').textContent = status;
  });
  board.access.subscribe((access) => {
    el('access').textContent = access ?? '';
  });
  board.state.subscribe((state) => {
    el('title').textContent = state.title.length > 100 ? '(long)' : state.title;
    el('title-length').textContent = String(state.title.length);
    el('tasks').textContent = state.tasks.map((t) => `${t.id}${t.done ? '+' : ''}`).join(',');
    el('archived').textContent = String(state.archived);
  });
  board.onRefused((refusal) => append('refused', refusal.reason));

  board.awareness.others.subscribe((others) => {
    el('viewers').textContent = [...others.values()]
      .map((member) => `${String(member.meta.username)}=${member.state?.viewingTaskId ?? ''}`)
      .sort()
      .join(',');
  });
  board.locks.subscribe((locks) => {
    el('locks').textContent = [...locks]
      .map(([key, holder]) => `${key}=${String(holder.meta.username)}`)
      .join(',');
  });

  button('connect', () => socket.connect());
  button('open', async () => {
    try {
      await board.open();
    } catch (error) {
      append('errors', errorCode(error));
    }
  });
  button('close', () => board.close());
  button('rename', () =>
    attempt(() =>
      board.change((d) => {
        d.title = (el('title-input') as HTMLInputElement).value;
      }),
    ),
  );
  button('add-task', () =>
    attempt(() =>
      board.change((d) => {
        const id = `t${d.tasks.length + 1}-${username}`;
        d.tasks.push({ id, column: 'todo', title: id, done: false, assignee: null, notes: '' });
      }),
    ),
  );

  button('toggle-first', () =>
    attempt(() =>
      board.change((d) => {
        const first = d.tasks.at(0);
        if (first) first.done = !first.done;
      }),
    ),
  );
  button('move-first-to-end', () =>
    attempt(() => board.change((d) => d.tasks.move(0, d.tasks.length - 1))),
  );
  button('prefix-first-task', () =>
    attempt(() =>
      board.change((d) => {
        const first = d.tasks.at(0);
        if (first) first.title = `New ${first.title}`;
      }),
    ),
  );
  button('undo', () => board.history.undo());
  // Writes past the schema, as an older app version could: the server undoes it.
  button('bad-edit', () => {
    const ydoc = board.yjs.doc;
    const first = ydoc.getArray<string>('tasks').get(0);
    if (!first) return;

    const task = ydoc.getMap<Y.Map<unknown>>('tasks#items').get(first);
    task?.set('done', 'yes');
  });
  button('big-title', () =>
    attempt(() =>
      board.change((d) => {
        d.title = 'x'.repeat(3_000_000);
      }),
    ),
  );
  button('archive', () => {
    socket.send('archive-board', { boardId: 'launch' });
  });
  button('view-first', () =>
    board.awareness.update({ viewingTaskId: board.state.get().tasks[0]?.id ?? null }),
  );
  button('lock-first', async () => {
    el('lock-result').textContent = String(
      await board.lock(`task:${board.state.get().tasks[0]?.id}`),
    );
  });

  button('unlock-first', () => board.unlock(`task:${board.state.get().tasks[0]?.id}`));
  button('anchor-first', () => {
    const anchor = board.anchor.text((p) => p.tasks[0]?.title, { from: 0, to: 2 });
    board.anchor.watch(anchor).subscribe((place) => {
      el('anchor').textContent = place ? `${place.from}-${place.to}` : 'gone';
    });
    const place = board.anchor.watch(anchor).get();
    el('anchor').textContent = place ? `${place.from}-${place.to}` : 'gone';
  });
  button('server-drop', () => {
    socket.send('server-drop', {});
  });

  ready();
}

setup();
