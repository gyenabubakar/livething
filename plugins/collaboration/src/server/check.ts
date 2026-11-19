import { LiveThingError } from '@livething/core';
import { rootSlots } from '~/doc/layout.ts';
import { Snapshots } from '~/doc/snapshot.ts';
import { isStorable } from '~/doc/values.ts';
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
   * The update broke the schema. It was applied and then undone by `revert`. Send `update`
   * merged with `revert` to the others, and `revert` to the sender. When the update wrote
   * outside the doc's layout, it was not applied at all, and both are `null`.
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
  let structs: ReturnType<typeof Y.decodeUpdate>['structs'];
  let starts: Map<number, number>;
  try {
    structs = Y.decodeUpdate(update).structs;
    starts = Y.parseUpdateMeta(update).from;
  } catch {
    return { ok: false, reason: 'the bytes are not a Yjs update', toOthers: null, toSender: null };
  }

  const names = new Set(rootSlots(core.def.shape).keys());
  for (const struct of structs) {
    const parent = (struct as { parent?: unknown }).parent;
    if (typeof parent === 'string' && !names.has(parent)) {
      return {
        ok: false,
        reason: `'${parent}' is not part of this doc`,
        toOthers: null,
        toSender: null,
      };
    }
  }

  // A client sends its updates in order over one connection, so an update that starts past
  // what the server has is out of order. Yjs would hold it until the missing part came, and
  // then check it as part of someone else's update.
  const have = Y.decodeStateVector(Y.encodeStateVector(core.ydoc));
  for (const [client, clock] of starts) {
    if (clock > (have.get(client) ?? 0)) {
      return {
        ok: false,
        reason: 'the update needs earlier updates the server does not have',
        toOthers: null,
        toSender: null,
      };
    }
  }

  const roots = [...core.roots.keys()];
  const undo = new Y.UndoManager(roots, { trackedOrigins: new Set([origin]), captureTimeout: 0 });
  const events: Seen[] = [];
  function collect(batch: Y.YEvent<any>[]) {
    events.push(...batch.map(see));
  }

  for (const root of roots) root.observeDeep(collect);

  try {
    Y.applyUpdate(core.ydoc, update, origin);
  } finally {
    for (const root of roots) root.unobserveDeep(collect);
  }

  const reason = check(core, events);
  if (reason === null) {
    undo.destroy();
    return { ok: true, update };
  }

  let revert: Uint8Array | null = null;
  function capture(piece: Uint8Array, from: unknown) {
    if (from === undo) revert = revert ? Y.mergeUpdates([revert, piece]) : piece;
  }

  core.ydoc.on('update', capture);
  undo.undo();
  core.ydoc.off('update', capture);

  undo.destroy();

  return {
    ok: false,
    reason,
    toOthers: revert ? Y.mergeUpdates([update, revert]) : update,
    toSender: revert,
  };
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
