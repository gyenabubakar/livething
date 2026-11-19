// Type-only checks for the client side of a doc. tsc checks these; vitest never runs them.
import { open, taskBoard } from '~/test/task-board.ts';
import { expectTypeOf } from 'vitest';
import type { ReadableStore } from '~/client/store.ts';
import type { Anchor, ItemPlace, TextPlace } from '~/doc/anchors.ts';
import type * as Y from 'yjs';

const board = open(taskBoard);
const state = board.state.get();

expectTypeOf(state.tasks[0]!.done).toEqualTypeOf<boolean>();
expectTypeOf(board.select((s) => s.tasks.length)).toEqualTypeOf<ReadableStore<number>>();
expectTypeOf(board.change((d) => d.tasks.length)).toEqualTypeOf<number>();

// ---- yjs.at(): the Yjs type an editor binds to ----

expectTypeOf(board.yjs.at((p) => p.title)).toEqualTypeOf<Y.Text>();
expectTypeOf(board.yjs.at((p) => p.tasks[0]?.notes)).toEqualTypeOf<Y.XmlFragment>();
// @ts-expect-error — a plain value has no Yjs type
board.yjs.at((p) => p.tasks[0]?.done);
// @ts-expect-error — a list item is not a Yjs type an editor binds to
board.yjs.at((p) => p.tasks[0]);

// ---- anchors ----

const onWords = board.anchor.text((p) => p.tasks[0]?.title, { from: 6, to: 11 });
const onNotes = board.anchor.text((p) => p.tasks[0]?.notes, { from: 0, to: 4 });
const onTask = board.anchor.item((p) => p.tasks[0]);
const onSettings = board.anchor.item((p) => p.settings['u_amara']);

expectTypeOf(board.anchor.watch(onWords)).toEqualTypeOf<ReadableStore<TextPlace | null>>();
expectTypeOf(board.anchor.watch(onNotes)).toEqualTypeOf<ReadableStore<TextPlace | null>>();
expectTypeOf(board.anchor.watch(onTask)).toEqualTypeOf<ReadableStore<ItemPlace | null>>();
expectTypeOf(board.anchor.watch(onSettings)).toEqualTypeOf<ReadableStore<ItemPlace | null>>();

// A stored anchor of either kind, such as one read back from JSON.
declare const stored: Anchor;
expectTypeOf(board.anchor.watch(stored)).toEqualTypeOf<
  ReadableStore<TextPlace | ItemPlace | null>
>();

// @ts-expect-error — a text anchor needs a text or rich text field
board.anchor.text((p) => p.tasks[0], { from: 0, to: 1 });
// @ts-expect-error — and a range
board.anchor.text((p) => p.title);
// @ts-expect-error — an item anchor needs a list item or record entry
board.anchor.item((p) => p.title);
// @ts-expect-error — not a plain value either
board.anchor.item((p) => p.tasks[0]?.done);
