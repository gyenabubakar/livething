import { LiveThingError } from '@livething/core';
import { Snapshots } from '~/doc/snapshot.ts';
import { isStorable } from '~/doc/values.ts';
import { OUT_OF_ORDER } from '~/doc/wire.ts';
import { kindOf } from '~/schema.ts';
import * as Y from 'yjs';
import type { DocCore } from '~/doc/core.ts';
import type { RootSlot } from '~/doc/layout.ts';
import type { InvalidChangeDetail } from '~/doc/values.ts';
import type { DocDef, Field, Leaf, ListField, RecordField, Shape } from '~/schema.ts';

/** What the check needs from one Yjs event. Yjs lets you read an event's changes only in its handler. */
interface Seen {
  readonly target: Y.AbstractType<any>;
  readonly path: readonly (string | number)[];
  readonly keys: readonly string[];
  readonly added: readonly unknown[];
  readonly textInserts: readonly unknown[];
}

/** The most bytes of one format mark in a text field (its name and its value as JSON). */
const MAX_FORMAT_BYTES = 1024;

function see(event: Y.YEvent<any>): Seen {
  return {
    target: event.target,
    path: event.path,
    keys: event instanceof Y.YMapEvent ? [...event.keysChanged] : [],
    added:
      event.target instanceof Y.Array || event.target instanceof Y.XmlFragment
        ? [...event.changes.added].flatMap((item) => item.content.getContent())
        : [],
    textInserts:
      event.target instanceof Y.Text
        ? (event.delta as { insert?: unknown }[])
            .filter((op) => op.insert !== undefined)
            .map((op) => op.insert)
        : [],
  };
}

/** What a nested Yjs type in the doc holds. */
type Slot = RootSlot | { readonly kind: 'rich' };

/** The slot one step down from `slot`, by `key`. */
function child(slot: Slot, key: string | number): Slot {
  if (slot.kind === 'items') return { kind: 'field', field: slot.list.item };

  if (slot.kind === 'rich') return slot;

  if (slot.kind !== 'field') throw new Error('this part holds no nested types');

  const field = slot.field;
  switch (kindOf(field)) {
    case 'rich-text':
      return { kind: 'rich' };

    case 'list':
      if (key === 'order') return { kind: 'order' };

      if (key === 'items') return { kind: 'items', list: field as ListField };

      throw new Error(`a list has no '${key}'`);

    case 'record':
      return { kind: 'field', field: (field as RecordField).item };

    case 'shape': {
      const sub = (field as Shape)[key as string];
      if (!sub) throw new Error(`no field '${key}'`);

      return { kind: 'field', field: sub };
    }

    default:
      throw new Error('this part holds no nested types');
  }
}

/** Check what one event changed. Returns the first problem, or `null`. */
function checkEvent(snapshots: Snapshots, slot: Slot, event: Seen): string | null {
  const map = event.target as Y.Map<unknown>;
  switch (slot.kind) {
    case 'values':
      for (const key of event.keys) {
        const field = slot.shape[key];
        if (!field || kindOf(field) !== 'leaf') return `'${key}' is not a value of this object`;

        snapshots.value(field as Leaf, map.get(key), key);
      }

      return null;

    case 'order':
      return event.added.every((id) => typeof id === 'string')
        ? null
        : 'a list order holds only IDs';

    case 'items':
      for (const key of event.keys) {
        if (map.has(key)) snapshots.field(slot.list.item, map.get(key), key);
      }

      return null;

    case 'rich':
      if (
        event.added.some((node) => !(node instanceof Y.XmlElement || node instanceof Y.XmlText))
      ) {
        return 'rich text holds only elements and text';
      }

      return event.textInserts.every(
        (insert) => typeof insert === 'string' || isStorable(insert, 0),
      )
        ? null
        : 'rich text holds only text and JSON embeds';

    case 'field':
      return checkField(snapshots, slot.field, event);
  }
}

function checkField(snapshots: Snapshots, field: Field, event: Seen) {
  const map = event.target as Y.Map<unknown>;
  switch (kindOf(field)) {
    case 'text':
      return event.textInserts.every((insert) => typeof insert === 'string')
        ? null
        : 'text holds only characters';

    case 'rich-text':
      return checkEvent(snapshots, { kind: 'rich' }, event);

    case 'record':
      for (const key of event.keys) {
        if (map.has(key)) snapshots.field((field as RecordField).item, map.get(key), key);
      }

      return null;

    case 'shape':
      for (const key of event.keys) {
        const sub = (field as Shape)[key];
        if (!sub) return `'${key}' is not a field of this object`;

        if (!map.has(key)) return `'${key}' cannot be deleted`;

        snapshots.field(sub, map.get(key), key);
      }

      return null;

    case 'list':
      return event.keys.length === 0 ? null : 'a list cannot be replaced';

    default:
      return 'a value holds no nested types';
  }
}

/** The result of applying a client's update on the server. */
export type CheckResult =
  /** The update is fine. Send it to the others. */
  | { readonly ok: true; readonly update: Uint8Array }
  /**
   * The update broke the schema, wrote outside the doc, or could not be applied whole. What the
   * server took of it was undone. Send `toOthers` (what the server took, with the undo) to the
   * others and store it, and send `toSender` (the undo) to the sender. When the update was out
   * of order, or not a Yjs update, nothing was applied, and both are `null`.
   */
  | {
      readonly ok: false;
      readonly reason: string;
      readonly toOthers: Uint8Array | null;
      readonly toSender: Uint8Array | null;
    };

/**
 * Apply a client's update to the server's copy, and check only what it changed. A bad update
 * is undone with a new update, so every copy still ends up the same and the bad content
 * never sticks.
 */
export function applyChecked<D extends DocDef>(
  core: DocCore<D>,
  update: Uint8Array,
  origin: unknown,
): CheckResult {
  let starts: Map<number, number>;
  let decoded: ReturnType<typeof Y.decodeUpdate>;
  try {
    // The full decode checks every struct, so bad bytes fail here and not half way in.
    decoded = Y.decodeUpdate(update);
    starts = Y.parseUpdateMeta(update).from;
  } catch {
    return { ok: false, reason: 'the bytes are not a Yjs update', toOthers: null, toSender: null };
  }

  // A client sends its updates in order over one connection, so an update that starts past
  // what the server has is out of order. Yjs would hold it until the missing part came, and
  // then check it as part of someone else's update.
  const have = Y.decodeStateVector(Y.encodeStateVector(core.ydoc));
  let outOfOrder = false;
  for (const [client, clock] of starts) if (clock > (have.get(client) ?? 0)) outOfOrder = true;
  // An update can also start in order and still point at items the server does not have.
  // Yjs would hold those items back, out of every check, and apply them when the items come,
  // inside someone else's update.
  if (outOfOrder || missesItems(decoded, have)) {
    return { ok: false, reason: OUT_OF_ORDER, toOthers: null, toSender: null };
  }

  const roots = [...core.roots.keys()];
  const undo = new Y.UndoManager(roots, { trackedOrigins: new Set([origin]), captureTimeout: 0 });
  const events: Seen[] = [];
  function collect(batch: Y.YEvent<any>[]) {
    events.push(...batch.map(see));
  }

  const written: Written = { outside: new Set(), wrongKind: null };
  function inspect(transaction: Y.Transaction) {
    if (transaction.origin === origin) inspectNewItems(core, transaction, written);
  }

  for (const root of roots) root.observeDeep(collect);
  // What the server took of the update. For a broken one that is less than the update, and
  // what the others get and what is stored must be what the server holds, not the raw bytes.
  let applied: Uint8Array | null = null;
  function keep(piece: Uint8Array, from: unknown) {
    if (from === origin) applied = applied ? Y.mergeUpdates([applied, piece]) : piece;
  }

  core.ydoc.on('afterTransaction', inspect);
  core.ydoc.on('update', keep);

  // An update an honest client sends always applies whole: every item it points at is on the
  // server or comes before it. One that makes Yjs throw half way, or leaves items held back,
  // was built by hand. What did apply is undone below with the rest.
  let broken = false;
  try {
    Y.applyUpdate(core.ydoc, update, origin);
  } catch {
    broken = true;
  } finally {
    core.ydoc.off('update', keep);
    core.ydoc.off('afterTransaction', inspect);
    for (const root of roots) root.unobserveDeep(collect);
  }

  const { store } = core.ydoc;
  if (store.pendingStructs || store.pendingDs) {
    store.pendingStructs = null;
    store.pendingDs = null;
    broken = true;
  }

  const [first] = written.outside;
  let reason: string | null;
  if (broken) reason = 'the update could not be applied whole';
  else if (first) reason = `'${Y.findRootTypeKey(first)}' is not part of this doc`;
  else reason = written.wrongKind ?? check(core, events);
  if (reason === null) {
    undo.destroy();
    return { ok: true, update };
  }

  const cleanup = {};
  let revert: Uint8Array | null = null;
  function capture(piece: Uint8Array, from: unknown) {
    if (from !== undo && from !== cleanup) return;

    revert = revert ? Y.mergeUpdates([revert, piece]) : piece;
  }

  core.ydoc.on('update', capture);
  undo.undo();
  core.ydoc.transact((transaction) => {
    for (const root of written.outside) deleteContent(root, transaction);
  }, cleanup);
  core.ydoc.off('update', capture);

  // The undo keeps what it deleted, for a redo that never comes: let it go, so the refused
  // content is dropped from the doc and from what the server stores, not only hidden.
  undo.clear();
  undo.destroy();
  Y.tryGc(Y.createDeleteSetFromStructStore(core.ydoc.store), core.ydoc.store, core.ydoc.gcFilter);

  // Both are set in the listeners above, which TypeScript does not follow.
  const pieces: Uint8Array[] = [];
  for (const piece of [applied as Uint8Array | null, revert as Uint8Array | null]) {
    if (piece) pieces.push(piece);
  }

  return {
    ok: false,
    reason,
    toOthers: pieces.length > 0 ? Y.mergeUpdates(pieces) : null,
    toSender: revert,
  };
}

/**
 * Whether `decoded` points at an item that neither the server (`have`) nor the update itself
 * holds: as an item's left or right neighbour or its parent, or in what it deletes.
 */
function missesItems(
  decoded: ReturnType<typeof Y.decodeUpdate>,
  have: Map<number, number>,
): boolean {
  // The clocks each client's structs cover in the update. Structs that follow each other join
  // into one range, as one delete can span several of them.
  const own = new Map<number, { from: number; to: number }[]>();
  for (const struct of decoded.structs) {
    if (struct instanceof Y.Skip) continue;

    const ranges = own.get(struct.id.client) ?? [];
    const last = ranges.at(-1);
    const from = struct.id.clock;
    if (last && last.to === from) last.to = from + struct.length;
    else ranges.push({ from, to: from + struct.length });
    own.set(struct.id.client, ranges);
  }

  function holds(client: number, from: number, to: number): boolean {
    if (to <= (have.get(client) ?? 0)) return true;

    const start = Math.max(from, have.get(client) ?? 0);
    return (own.get(client) ?? []).some((range) => range.from <= start && to <= range.to);
  }

  function holdsId(id: unknown): boolean {
    if (!(id instanceof Y.ID)) return true;

    return holds(id.client, id.clock, id.clock + 1);
  }

  for (const struct of decoded.structs) {
    if (!(struct instanceof Y.Item)) continue;

    if (!holdsId(struct.origin) || !holdsId(struct.rightOrigin) || !holdsId(struct.parent)) {
      return true;
    }
  }

  for (const [client, deletes] of decoded.ds.clients) {
    for (const range of deletes) {
      if (!holds(client, range.clock, range.clock + range.len)) return true;
    }
  }

  return false;
}

/** What the new items of an update wrote that no field check sees. */
interface Written {
  /** Root types outside the doc's layout that got content. */
  readonly outside: Set<Y.AbstractType<any>>;
  /** The first item of the wrong kind for the type it went into. */
  wrongKind: string | null;
}

function rootOf(type: Y.AbstractType<any>): Y.AbstractType<any> {
  let root = type;
  while (root._item) root = root._item.parent as Y.AbstractType<any>;

  return root;
}

/**
 * Every Yjs type has a list part and a keyed part, and a client can write to either, with any
 * kind of content. A doc field uses one part: a map only its keys, a list only plain values,
 * a text only characters and format marks. Rich text has its own check, and its elements take
 * attributes. Yjs events do not show all of it (a text event leaves out a list item that is
 * not text), so this reads the items themselves.
 */
function itemKindProblem(item: Y.Item, parent: Y.AbstractType<any>): string | null {
  const keyed = item.parentSub !== null;
  if (parent instanceof Y.XmlFragment || parent instanceof Y.XmlText) {
    // The rich text check reads the nodes; here only the size of attributes and marks.
    if (keyed) {
      if (!(parent instanceof Y.XmlElement || parent instanceof Y.XmlText)) {
        return 'rich text keeps attributes only on its elements';
      }

      return markBytes(item.parentSub!, item.content.getContent()[0]) <= MAX_FORMAT_BYTES
        ? null
        : `an attribute can be at most ${MAX_FORMAT_BYTES} bytes`;
    }

    const { content } = item;
    return content instanceof Y.ContentFormat &&
      markBytes(content.key, content.value) > MAX_FORMAT_BYTES
      ? `a format mark can be at most ${MAX_FORMAT_BYTES} bytes`
      : null;
  }

  if (parent instanceof Y.Map) return keyed ? null : 'a map holds only keyed values';

  if (keyed) return 'a list or a text holds no keyed values';

  const { content } = item;
  // Every list in a doc's layout is a list order: item IDs, as strings.
  if (!(parent instanceof Y.Text)) {
    return content instanceof Y.ContentAny &&
      content.getContent().every((id) => typeof id === 'string')
      ? null
      : 'a list order holds only item IDs';
  }

  if (content instanceof Y.ContentString) return null;

  const smallFormat =
    content instanceof Y.ContentFormat && markBytes(content.key, content.value) <= MAX_FORMAT_BYTES;

  return smallFormat ? null : 'text holds only characters and small format marks';
}

/**
 * A key of a nested map the schema does not have, such as an extra field on a new list item
 * or record entry. A new nested map fires no event of its own, so the event checks miss it.
 */
function unknownField<D extends DocDef>(
  core: DocCore<D>,
  item: Y.Item,
  parent: Y.AbstractType<any>,
): string | null {
  const key = item.parentSub;
  if (key === null || !(parent instanceof Y.Map) || !parent._item) return null;

  const path: string[] = [];
  let type: Y.AbstractType<any> = parent;
  while (type._item) {
    const sub = type._item.parentSub;
    if (sub === null) return null;

    path.unshift(sub);
    type = type._item.parent as Y.AbstractType<any>;
  }

  let slot: Slot | undefined = core.roots.get(type);
  try {
    for (const step of path) slot = slot && child(slot, step);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  if (!slot || slot.kind !== 'field') return null;

  // A nested list keeps two parts in its map: its order and its items.
  if (kindOf(slot.field) === 'list') {
    return key === 'order' || key === 'items' ? null : `a list has no '${key}'`;
  }

  if (kindOf(slot.field) !== 'shape') return null;

  return Object.hasOwn(slot.field, key) ? null : `'${key}' is not a field of this object`;
}

/** The bytes an attribute or a format mark takes: its name and its value as JSON. */
function markBytes(key: string, value: unknown): number {
  return key.length + JSON.stringify(value ?? null).length;
}

/** Look at every item `transaction` added: what it costs is the size of the update. */
function inspectNewItems<D extends DocDef>(
  core: DocCore<D>,
  transaction: Y.Transaction,
  written: Written,
): void {
  for (const [client, after] of transaction.afterState) {
    const before = transaction.beforeState.get(client) ?? 0;
    const structs = core.ydoc.store.clients.get(client);
    if (after <= before || !structs) continue;

    for (let index = Y.findIndexSS(structs, before); index < structs.length; index += 1) {
      const item = structs[index];
      if (!(item instanceof Y.Item) || item.deleted) continue;

      const parent = item.parent as Y.AbstractType<any>;
      const root = rootOf(parent);
      if (!core.roots.has(root)) written.outside.add(root);
      else written.wrongKind ??= itemKindProblem(item, parent) ?? unknownField(core, item, parent);
    }
  }
}

/**
 * Delete everything in a root type the doc does not have. Its kind (map, array, text) is not
 * known, so this goes through Yjs's own items: the list part and the map part.
 */
function deleteContent(type: Y.AbstractType<any> | undefined, transaction: Y.Transaction): void {
  if (!type) return;

  for (let item = type._start; item; item = item.right) {
    if (!item.deleted) item.delete(transaction);
  }

  for (const item of type._map.values()) {
    if (!item.deleted) item.delete(transaction);
  }
}

function check<D extends DocDef>(core: DocCore<D>, events: readonly Seen[]): string | null {
  const snapshots = new Snapshots(core.ydoc);
  try {
    for (const event of events) {
      let root: Y.AbstractType<any> = event.target;
      while (root._item) root = root._item.parent as Y.AbstractType<any>;

      let slot: Slot | undefined = core.roots.get(root);
      if (!slot) return 'the update changed a part that is not in this doc';

      for (const key of event.path) slot = child(slot, key);

      const reason = checkEvent(snapshots, slot, event);
      if (reason !== null) return reason;
    }
  } catch (error) {
    if (error instanceof LiveThingError && error.code === 'invalid-change') {
      const { path, reason } = error.detail as InvalidChangeDetail;
      return `${path}: ${reason}`;
    }

    return error instanceof Error ? error.message : String(error);
  }

  return null;
}
