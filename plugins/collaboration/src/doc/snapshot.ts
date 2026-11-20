import { liveIds, nestedList, rootList, rootType, valuesMap } from '~/doc/layout.ts';
import { invalidChange, readValue, richTextLayout } from '~/doc/values.ts';
import { kindOf } from '~/schema.ts';
import * as Y from 'yjs';
import type { ListParts } from '~/doc/layout.ts';
import type { Field, Leaf, ListField, RecordField, Shape } from '~/schema.ts';

/** What a field of `kind` should hold, in the words every refusal uses. */
function expected(kind: ReturnType<typeof kindOf>): string {
  const what = {
    text: 'text',
    'rich-text': 'rich text',
    list: 'a list',
    record: 'a record',
    leaf: 'a value',
    shape: 'an object',
  } as const;
  return `expected ${what[kind]}`;
}

function freeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;

  if (ArrayBuffer.isView(value)) return value;

  for (const item of Object.values(value)) freeze(item);
  return Object.freeze(value);
}

function sameShallow(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;

  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  }

  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;

  const keys = Object.keys(a);

  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.is((a as never)[key], (b as never)[key]))
  );
}

/**
 * Read-only, plain JSON copies of a doc, with structural sharing: a part that did not
 * change is the same object as before, so a framework skips the work for it.
 *
 * Each Yjs type's copy is cached until the type is marked dirty. A dirty part is read
 * again, and if nothing in it differs from the cached copy, the cached object is kept.
 */
export class Snapshots {
  private readonly ydoc: Y.Doc;
  /** Weak, so a deleted type and its copy go away with the type. */
  private readonly cache = new WeakMap<Y.AbstractType<any>, unknown>();
  private readonly fixed = new Map<string, Record<string, unknown>>();
  /** Each stored value object's output, so an unchanged value keeps its object. */
  private readonly outputs = new WeakMap<object, unknown>();
  /** The types that changed since their copy was made. */
  readonly dirty = new WeakSet<Y.AbstractType<any>>();
  /** The list ID of each item object in a list copy, for `keyOf`. */
  readonly keys = new WeakMap<object, string>();

  constructor(ydoc: Y.Doc) {
    this.ydoc = ydoc;
  }

  /** The whole doc. */
  doc(shape: Shape): Record<string, unknown> {
    return this.fixedShape(shape, []);
  }

  /** A value: its schema's output, the same object while the stored value is the same. */
  value(schema: Leaf, stored: unknown, path: string): unknown {
    if (typeof stored !== 'object' || stored === null) {
      return freeze(readValue(schema, stored, path));
    }

    if (this.outputs.has(stored)) return this.outputs.get(stored);

    const output = freeze(readValue(schema, stored, path));
    this.outputs.set(stored, output);

    return output;
  }

  /** A field inside a list item or record value. */
  field(field: Field, raw: unknown, path: string): unknown {
    switch (kindOf(field)) {
      case 'leaf':
        return this.value(field as Leaf, raw, path);

      case 'list': {
        const parts = nestedList(raw);
        if (!parts) throw invalidChange(path, 'expected a list');

        return this.list((field as ListField).item, parts, path);
      }

      default:
        if (!(raw instanceof Y.AbstractType)) throw invalidChange(path, expected(kindOf(field)));

        return this.type(field, raw, path);
    }
  }

  list(item: Field, parts: ListParts, path: string): readonly unknown[] {
    if (this.cache.has(parts.key) && !this.dirty.has(parts.key)) {
      return this.cache.get(parts.key) as unknown[];
    }

    const out = liveIds(parts).map((id) => {
      const value = this.field(item, parts.items.get(id), `${path}[]`);
      if (typeof value === 'object' && value !== null) this.keys.set(value, id);
      return value;
    });
    return this.keep(parts.key, Object.freeze(out)) as unknown[];
  }

  private type(field: Field, type: Y.AbstractType<any>, path: string): unknown {
    if (this.cache.has(type) && !this.dirty.has(type)) return this.cache.get(type);

    let value: unknown;
    switch (kindOf(field)) {
      case 'text':
        if (!(type instanceof Y.Text) || type instanceof Y.XmlText) {
          throw invalidChange(path, 'expected text');
        }

        value = type.toString();
        break;

      case 'rich-text':
        if (!(type instanceof Y.XmlFragment) || type instanceof Y.XmlElement) {
          throw invalidChange(path, 'expected rich text');
        }

        value = richTextLayout(type).text;
        break;

      case 'record': {
        if (!(type instanceof Y.Map)) throw invalidChange(path, 'expected a record');

        const out: Record<string, unknown> = {};
        // Keys are the app's own, so `__proto__` must become a key, not the prototype.
        for (const [key, raw] of type.entries()) {
          Object.defineProperty(out, key, {
            value: this.field((field as RecordField).item, raw, `${path}{}`),
            enumerable: true,
            writable: true,
            configurable: true,
          });
        }

        value = Object.freeze(out);
        break;
      }

      case 'shape': {
        if (!(type instanceof Y.Map)) throw invalidChange(path, 'expected an object');

        const out: Record<string, unknown> = {};
        for (const [key, sub] of Object.entries(field as Shape)) {
          out[key] = this.field(sub, type.get(key), `${path}.${key}`);
        }

        value = Object.freeze(out);
        break;
      }

      default:
        throw invalidChange(path, 'expected a Yjs type');
    }

    return this.keep(type, value);
  }

  /** A fixed object: its values in its values map, the rest in root types. */
  private fixedShape(shape: Shape, path: string[]): Record<string, unknown> {
    const values = valuesMap(this.ydoc, path);
    const out: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(shape)) {
      const fieldPath = [...path, key];
      const where = fieldPath.join('.');
      switch (kindOf(field)) {
        case 'leaf':
          out[key] = this.value(field as Leaf, values.get(key), where);
          break;

        case 'shape':
          out[key] = this.fixedShape(field as Shape, fieldPath);
          break;

        case 'list':
          out[key] = this.list((field as ListField).item, rootList(this.ydoc, fieldPath), where);
          break;

        default:
          out[key] = this.type(field, rootType(this.ydoc, field, fieldPath), where);
      }
    }

    const name = path.join('/');
    const previous = this.fixed.get(name);
    if (previous && sameShallow(previous, out)) return previous;

    const frozen = Object.freeze(out);
    this.fixed.set(name, frozen);

    return frozen;
  }

  private keep(type: Y.AbstractType<any>, value: unknown): unknown {
    const previous = this.cache.get(type);
    const kept = this.cache.has(type) && sameShallow(previous, value) ? previous : value;
    this.cache.set(type, kept);
    this.dirty.delete(type);

    return kept;
  }
}
