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
/** How deep elements nest in rich text. Reading deeper rich text would run out of stack. */
const MAX_RICH_DEPTH = 100;
/**
 * How deep Yjs types nest in a doc, counted from its root. Yjs deletes and copies nested
 * types by recursion, so a chain thousands deep would make deleting, undoing or restoring
 * the item run out of stack for good. A doc's own layout, with rich text 100 deep, stays far
 * below it.
 */
const MAX_NESTING = 200;

function idKey(id: Y.ID): string {
  return `${id.client}:${id.clock}`;
}

/**
 * Whether the update itself holds a chain of nested types deeper than `MAX_NESTING`. This
 * runs before the update applies: undoing a deep chain after it applied would also run out
 * of stack. It walks the decoded items with no recursion, and remembers what it found.
 */
function nestsTooDeep(decoded: ReturnType<typeof Y.decodeUpdate>): boolean {
  const items = new Map<string, Y.Item>();
  for (const struct of decoded.structs) {
    if (struct instanceof Y.Item) items.set(idKey(struct.id), struct);
  }

  // An item's parent is written only on the first item of a list or a map key; the others
  // name their neighbour (`origin`), whose parent is theirs.
  const parents = new Map<string, string | null>();
  function parentOf(key: string): string | null {
    const path: string[] = [];
    const seen = new Set<string>();
    let current: string | undefined = key;
    let found: string | null = null;
    // Two neighbours can name each other (one as its left, one as its right): stop on a repeat.
    while (current !== undefined && !seen.has(current)) {
      if (parents.has(current)) {
        found = parents.get(current)!;
        break;
      }

      seen.add(current);
      path.push(current);
      const item = items.get(current);
      const { parent } = item ?? {};
      if (parent instanceof Y.ID) {
        found = idKey(parent);
        break;
      }

      const next = item && !parent ? (item.origin ?? item.rightOrigin) : null;
      current = next ? idKey(next) : undefined;
    }

    for (const step of path) parents.set(step, found);

    return found;
  }

  const depths = new Map<string, number>();
  for (const key of items.keys()) {
    const path: string[] = [];
    let current: string | null = key;
    let depth = 0;
    while (current !== null && items.has(current)) {
      const known = depths.get(current);
      if (known !== undefined) {
        depth = known;
        break;
      }

      path.push(current);
      // Too deep already. This also ends a loop that a hand-made update can build, where two
      // items are each other's parent.
      if (path.length > MAX_NESTING) return true;

      current = parentOf(current);
    }

    for (let index = path.length - 1; index >= 0; index -= 1) {
      depth += 1;
      depths.set(path[index]!, depth);
    }

    if (depth > MAX_NESTING) return true;
  }

  return false;
}

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

/**
 * What a nested Yjs type in the doc holds. `unread` is content under a key the schema does
 * not have, such as a field removed from the doc type that old items still hold: the doc
 * keeps it and never reads it, so undo and restore can bring it back.
 */
type Slot = RootSlot | { readonly kind: 'rich' } | { readonly kind: 'unread' };

/** The slot one step down from `slot`, by `key`. */
function child(slot: Slot, key: string | number): Slot {
  if (slot.kind === 'items') return { kind: 'field', field: slot.list.item };

  if (slot.kind === 'rich' || slot.kind === 'unread') return slot;

  if (slot.kind === 'values' && !Object.hasOwn(slot.shape, key)) return { kind: 'unread' };

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
      // Own keys only: `__proto__` or `toString` is a key like any other, not a field.
      return Object.hasOwn(field as Shape, key)
        ? { kind: 'field', field: (field as Shape)[key as string]! }
        : { kind: 'unread' };
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
        // A key the schema does not have is kept unread (see `unread`).
        if (!Object.hasOwn(slot.shape, key)) continue;

        const field = slot.shape[key]!;
        if (kindOf(field) !== 'leaf') return `'${key}' is not a value of this object`;

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

    case 'unread':
      return null;
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
        // A key the schema does not have is kept unread (see `unread`).
        if (!Object.hasOwn(field as Shape, key)) continue;

        const sub = (field as Shape)[key]!;

        // A deleted value reads as its default, as in an item stored before the field
        // existed: undo and restore delete it that way. With no default, the read refuses it.
        if (!map.has(key) && kindOf(sub) !== 'leaf') return `'${key}' cannot be deleted`;

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
  /** The update is fine. Send it to the others, and store it; `null` when it changed nothing. */
  | { readonly ok: true; readonly update: Uint8Array | null }
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

  if (nestsTooDeep(decoded)) {
    const reason = `Yjs types can nest at most ${MAX_NESTING} deep`;
    return { ok: false, reason, toOthers: null, toSender: null };
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
    // Nothing new, as when a client that is in step joins and sends its whole delete set.
    return { ok: true, update: applied ? update : null };
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

/** How many rich text nodes hold `type`, itself included. */
function richDepth(type: Y.AbstractType<any>): number {
  let depth = 0;
  let node: Y.AbstractType<any> | null = type;
  while (node instanceof Y.XmlElement || node instanceof Y.XmlText) {
    depth += 1;
    node = (node._item?.parent as Y.AbstractType<any> | undefined) ?? null;
  }

  return depth;
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

      if (!(item.content instanceof Y.ContentAny)) return 'an attribute holds only a plain value';

      return markBytes(item.parentSub!, item.content.getContent()[0]) <= MAX_FORMAT_BYTES
        ? null
        : `an attribute can be at most ${MAX_FORMAT_BYTES} bytes`;
    }

    const { content } = item;
    // An element counts toward the depth; the text at the bottom of the elements does not.
    if (
      content instanceof Y.ContentType &&
      richDepth(parent) + (content.type instanceof Y.XmlElement ? 1 : 0) > MAX_RICH_DEPTH
    ) {
      return `rich text can be at most ${MAX_RICH_DEPTH} elements deep`;
    }

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
 * A key a nested map can't have, such as a third part in a nested list's map. A new nested
 * map fires no event of its own, so the event checks miss it.
 */
function misplacedKey<D extends DocDef>(
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

  // A nested list keeps two parts in its map: its order and its items. An object's key the
  // schema does not have is kept unread (see `unread`).
  if (kindOf(slot.field) === 'list') {
    return key === 'order' || key === 'items' ? null : `a list has no '${key}'`;
  }

  return null;
}

/** The bytes an attribute or a format mark takes: its name and its value as JSON. */
const utf8 = new TextEncoder();

function markBytes(key: string, value: unknown): number {
  return utf8.encode(key + JSON.stringify(value ?? null)).length;
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
      let root = parent;
      let depth = 0;
      while (root._item) {
        root = root._item.parent as Y.AbstractType<any>;
        depth += 1;
      }

      if (!core.roots.has(root)) {
        written.outside.add(root);
      }
      // Many updates that each nest a little could still build a deep chain: count from the root.
      else if (item.content instanceof Y.ContentType && depth >= MAX_NESTING) {
        written.wrongKind ??= `Yjs types can nest at most ${MAX_NESTING} deep`;
      } else {
        written.wrongKind ??= itemKindProblem(item, parent) ?? misplacedKey(core, item, parent);
      }
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
