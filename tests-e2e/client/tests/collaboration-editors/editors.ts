import {
  awareness,
  binary,
  channels,
  client,
  clientRequests,
  connect,
  reconnection,
} from '@livething/client';
import { collaboration } from '@livething/plugin-collaboration/client';
import { huddleDocs } from '@livething/tests-e2e-handlers/collaboration/docs';
import type { CollaborationClient } from '@livething/tests-e2e-handlers/collaboration';
import type * as Y from 'yjs';
import { button, el, mount, ready, wsUrl } from '../_shared.ts';

// Real editors on Huddle's launch task board, bound through `board.yjs`. `?editor=` picks one:
// the rich text editors (ProseMirror, Tiptap) edit the first task's notes, a `richText()`
// field; the text editors (CodeMirror, Quill, Monaco) edit the board title, a `text()` field.
// The page shows the field's text, and the other members whose editor cursor it can see.
type EditorName = 'prosemirror' | 'tiptap' | 'codemirror' | 'quill' | 'monaco';

export function setup(): void {
  mount(`
    <button data-testid="connect">connect</button>
    <button data-testid="open">open</button>
    <button data-testid="add-task">add-task</button>
    <button data-testid="mount">mount</button>
    <span data-testid="status"></span>
    <span data-testid="text"></span>
    <span data-testid="remote-cursors"></span>
    <span data-testid="own-cursor"></span>
    <span data-testid="refused"></span>
    <div data-testid="editor" style="min-height: 120px; border: 1px solid #ccc"></div>
  `);

  const page = new URLSearchParams(location.search);
  const username = page.get('username') ?? 'alice';
  const editor = (page.get('editor') ?? 'prosemirror') as EditorName;
  const richText = editor === 'prosemirror' || editor === 'tiptap';

  const HuddleCollaboration = collaboration({ docs: huddleDocs, closeDelayMs: 0 });
  const socket = client<CollaborationClient>()(
    connect(wsUrl('collaboration')),
    channels(),
    binary(),
    awareness(),
    clientRequests(),
    reconnection(),
    HuddleCollaboration(),
  );
  const board = HuddleCollaboration.use(socket).doc('task-board', 'launch');

  board.status.subscribe((status) => {
    el('status').textContent = status;
  });
  board.state.subscribe((state) => {
    el('text').textContent = richText ? (state.tasks[0]?.notes ?? '') : state.title;
  });

  board.onRefused((refusal) => {
    el('refused').textContent += `${refusal.reason};`;
  });

  function showCursors(): void {
    const names: string[] = [];
    for (const [clientId, state] of board.yjs.awareness.getStates()) {
      if (clientId === board.yjs.doc.clientID) continue;

      // Each binding keeps its caret under one of these fields.
      if (state.cursor || state.selection) names.push(String(state.user?.name));
    }

    el('remote-cursors').textContent = names.sort().join(',');
    // Where this member's own caret is, as the binding last published it.
    const own = board.yjs.awareness.getLocalState();
    el('own-cursor').textContent = JSON.stringify(own?.cursor ?? own?.selection ?? null);
  }

  async function mountEditor(host: HTMLElement): Promise<void> {
    const yAwareness = board.yjs.awareness;
    yAwareness.setLocalStateField('user', {
      name: username,
      color: '#c0392b',
      colorLight: '#f5b7b1',
    });
    yAwareness.on('change', showCursors);

    if (editor === 'prosemirror') {
      const [{ EditorState }, { EditorView }, { schema }, y] = await Promise.all([
        import('prosemirror-state'),
        import('prosemirror-view'),
        import('prosemirror-schema-basic'),
        import('y-prosemirror'),
      ]);
      const fragment: Y.XmlFragment = board.yjs.at((p) => p.tasks[0]?.notes);
      new EditorView(host, {
        state: EditorState.create({
          schema,
          plugins: [y.ySyncPlugin(fragment), y.yCursorPlugin(yAwareness), y.yUndoPlugin()],
        }),
      });
    } else if (editor === 'tiptap') {
      const [{ Editor }, { StarterKit }, { Collaboration }, { CollaborationCaret }] =
        await Promise.all([
          import('@tiptap/core'),
          import('@tiptap/starter-kit'),
          import('@tiptap/extension-collaboration'),
          import('@tiptap/extension-collaboration-caret'),
        ]);
      new Editor({
        element: host,
        extensions: [
          StarterKit.configure({ undoRedo: false }),
          Collaboration.configure({ fragment: board.yjs.at((p) => p.tasks[0]?.notes) }),
          CollaborationCaret.configure({
            provider: { awareness: yAwareness },
            user: { name: username, color: '#c0392b' },
          }),
        ],
      });
    } else if (editor === 'codemirror') {
      const [{ EditorState }, { EditorView }, { yCollab }] = await Promise.all([
        import('@codemirror/state'),
        import('@codemirror/view'),
        import('y-codemirror.next'),
      ]);
      const ytext: Y.Text = board.yjs.at((p) => p.title);
      new EditorView({
        parent: host,
        state: EditorState.create({
          doc: ytext.toString(),
          extensions: [yCollab(ytext, yAwareness)],
        }),
      });
    } else if (editor === 'quill') {
      const [{ default: Quill }, { default: QuillCursors }, { QuillBinding }] = await Promise.all([
        import('quill'),
        import('quill-cursors'),
        import('y-quill'),
      ]);
      Quill.register('modules/cursors', QuillCursors);
      const quill = new Quill(host, { modules: { cursors: true, toolbar: false } });
      new QuillBinding(
        board.yjs.at((p) => p.title),
        quill,
        yAwareness,
      );
    } else {
      const [monaco, { MonacoBinding }] = await Promise.all([
        import('monaco-editor'),
        import('y-monaco'),
      ]);
      const instance = monaco.editor.create(host, { value: '', language: 'plaintext' });
      new MonacoBinding(
        board.yjs.at((p) => p.title),
        instance.getModel()!,
        new Set([instance]),
        yAwareness,
      );
    }

    showCursors();
    el('editor').dataset.mounted = 'yes';
  }

  button('connect', () => socket.connect());
  button('open', () => board.open());
  button('add-task', () => {
    board.change((d) => {
      d.tasks.push({
        id: 't1',
        column: 'todo',
        title: 'Write the agenda',
        done: false,
        assignee: null,
        notes: '',
      });
    });
  });
  button('mount', () => mountEditor(el('editor')));

  ready();
}

setup();
