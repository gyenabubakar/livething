# @livething/plugin-collaboration

**Realtime collaborative editing for TypeScript apps.** Shared docs that many people edit at the same time, such as a task board, a form or meeting notes, on your own [LiveThing](https://livething.dev) server. Each doc is a CRDT built on [Yjs](https://yjs.dev), so edits from different people never conflict.

You describe a doc once, in code the server and the client share, and every type comes from that description.

- **Edits merge.** Two people can type in the same text, add items at the same spot, or move the same item, and every copy ends up the same.
- **The server checks every change** against the doc's schema. A bad change is undone for everyone.
- **Undo and redo** for each person: your undo takes back only your changes.
- **Real list moves:** a moved item is moved, never copied.
- **Awareness and locks:** see what each member has open, and let one member at a time edit a part.
- **Shared carets** in plain inputs with `bindText()` and `carets()`, and Yjs bindings for ProseMirror, Tiptap, BlockNote, CodeMirror, Monaco and Quill.
- **Anchors** that stay on their words or items as people edit, for comments and highlights.
- **Versions:** save a doc, read an old version, and restore it.
- **Offline edits** go out when the socket is back, and with device storage they survive a reload.
- **Server hooks:** fill a new doc from your own database with `onLoad`, and run work after edits with `onSave`, which says who edited.
- Runs on Node.js and Cloudflare Durable Objects, and stores docs in the server's own SQL.

## Install

```bash
npm install @livething/plugin-collaboration yjs
```

| Import                                   | What it has                                                         |
| ---------------------------------------- | ------------------------------------------------------------------- |
| `@livething/plugin-collaboration`        | `doc()`, `text()`, `richText()`, `list()`, `record()`, shared types |
| `@livething/plugin-collaboration/server` | the server plugin, `sqlStorage()`                                   |
| `@livething/plugin-collaboration/client` | the client plugin, `indexedDbStorage()`                             |

`yjs` is a peer dependency, so your app and any editor binding share one copy of it.

## Example

Describe a doc once, in a file both sides import:

```typescript
import { doc, list, text } from '@livething/plugin-collaboration';
import * as v from 'valibot';

export const taskBoard = doc('task-board', {
  title: text(),
  tasks: list({ id: v.string(), title: text(), done: v.boolean() }),
});
```

Then open it on the client, read it, and change it:

```typescript
// HuddleCollaboration is your client plugin, and socket is your LiveThing client.
const board = HuddleCollaboration.use(socket).doc('task-board', 'general');
await board.open();

board.state.subscribe((state) => console.info(state.title, state.tasks.length));

board.change((draft) => {
  draft.tasks.push({ id: 't_1042', title: 'Write the launch post', done: false });
});
```

## Docs

- [Overview](https://livething.dev/plugins/collaboration/overview)
- [The server](https://livething.dev/plugins/collaboration/server)
- [The client](https://livething.dev/plugins/collaboration/client)

LiveThing is in alpha: its API can change in any release.

## License

MIT
