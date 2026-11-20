import { LiveThingConfigError } from '@livething/core';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type * as Y from 'yjs';

const KIND = '~collab';

/** Text that several people type into together. Reads as a `string`. */
export interface TextField {
  readonly [KIND]: 'text';
}

/** Rich text that an editor such as ProseMirror changes. Reads as plain text, for previews. */
export interface RichTextField {
  readonly [KIND]: 'rich-text';
}

/** A list whose items people add, delete and move at the same time. */
export interface ListField<TItem extends Field = Field> {
  readonly [KIND]: 'list';
  readonly item: TItem;
}

/** A map from keys you choose, such as user IDs, to items. */
export interface RecordField<TItem extends Field = Field> {
  readonly [KIND]: 'record';
  readonly item: TItem;
}

/** Any Standard Schema (valibot, zod, arktype, ...): a value that changes as a whole. */
export type Leaf = StandardSchemaV1;

/** A plain object of fields. Each field merges on its own. */
export interface Shape {
  readonly [key: string]: Field;
}

/** One part of a doc. */
export type Field = TextField | RichTextField | ListField<any> | RecordField<any> | Leaf | Shape;

/**
 * Text that several people type into together. Edits merge letter by letter, so two people
 * can type in the same field and both edits stay. It reads as a `string`, and you write it
 * by assigning a string in `change()`: the plugin works out which letters changed and edits
 * only those. A plain `<input>` binds to it with `bindText()`, and a code or plain text
 * editor (CodeMirror, Monaco, Quill) binds to its `Y.Text` through `yjs.at()`.
 *
 * @example
 * ```ts
 * const taskBoard = doc('task-board', { title: text() })
 * board.change((d) => {
 *   d.title = 'Launch plan'
 * })
 * ```
 */
export function text(): TextField {
  return { [KIND]: 'text' };
}

/**
 * Rich text, edited through an editor's Yjs binding: ProseMirror (y-prosemirror) or Tiptap.
 * Its Yjs type is a `Y.XmlFragment`, which you get with `yjs.at()`. It reads as plain text
 * (for previews and search), one line per block. `change()` cannot assign it: edit it in the
 * editor. When you create an item that holds it (`push`, `insert`, `set`), you may give it
 * as a string, and each line becomes a `paragraph`.
 *
 * Lexical is not supported: its binding needs a different Yjs type.
 *
 * @example
 * ```ts
 * const taskBoard = doc('task-board', { tasks: list({ id: v.string(), notes: richText() }) })
 * const notes = board.yjs.at((p) => p.tasks[0]?.notes) // Y.XmlFragment
 * ```
 */
export function richText(): RichTextField {
  return { [KIND]: 'rich-text' };
}

/**
 * A list of `item`. Adds, deletes and moves from different people all merge. A move moves
 * the item itself and never copies it, so when two people move the same item at once it
 * still shows up once, and edits made to it during the move stay. Each item has an internal
 * ID that stays the same when it moves: `keyOf()` gives it, and item anchors use it.
 *
 * It reads as a read-only array, and in `change()` it has `push`, `insert`, `set`,
 * `delete`, `move`, `at`, `find` and `findIndex`.
 *
 * @param item The shape of one item: any field, such as a plain object of fields.
 *
 * @example
 * ```ts
 * const taskBoard = doc('task-board', {
 *   tasks: list({ id: v.string(), title: text(), done: v.boolean() }),
 * })
 * board.change((d) => d.tasks.move(0, 2))
 * ```
 */
export function list<const TItem extends Field>(item: TItem): ListField<TItem> {
  return { [KIND]: 'list', item };
}

/**
 * A map from keys you choose, such as user IDs, to `item`. Each key merges on its own, so
 * two people who set different keys at once both keep their value. It reads as a read-only
 * object, and in `change()` it has `get`, `set`, `has`, `delete`, `keys` and `size`.
 *
 * @param item The shape of each value.
 *
 * @example
 * ```ts
 * const taskBoard = doc('task-board', {
 *   settings: record({ collapsed: v.array(v.string()) }), // by user ID
 * })
 * board.change((d) => d.settings.set(userId, { collapsed: ['done'] }))
 * ```
 */
export function record<const TItem extends Field>(item: TItem): RecordField<TItem> {
  return { [KIND]: 'record', item };
}

/**
 * A doc type: its name, the shape of its content, and the shape of each member's awareness
 * state. Made by {@link doc}. Give the same list of them to the server plugin and the client
 * plugin.
 */
export interface DocDef<
  TName extends string = string,
  TShape extends Shape = Shape,
  TAwareness extends Leaf | undefined = Leaf | undefined,
> {
  readonly name: TName;
  readonly shape: TShape;
  readonly awareness: TAwareness;
}

/** The options of {@link doc}. */
export interface DocOptions<TAwareness extends Leaf | undefined> {
  /** The shape of each member's live state in this doc, such as the task they are looking at. */
  readonly awareness?: TAwareness;
}

const DOC_NAME = /^[a-z][a-z0-9-]{0,63}$/;
const FIELD_NAME = /^[A-Za-z_$][\w$]*$/;
const RESERVED_FIELD_NAMES: ReadonlySet<string> = new Set(
  Object.getOwnPropertyNames(Object.prototype),
);

/**
 * Describe a doc type once, in code the server and the client share. Every type the
 * plugin uses is read from it: the snapshot you read, the draft `change()` gives you, what
 * `yjs.at()` returns, the awareness state, and the doc names `collab.doc()` takes.
 *
 * A field is `text()`, `richText()`, `list(...)`, `record(...)`, a plain object of fields,
 * or any Standard Schema (valibot, zod, arktype, ...) for a value that changes as a whole.
 * A schema must check a value at once (not async), and its output must be JSON or bytes.
 *
 * @param name The doc type's name: 1 to 64 lowercase letters, digits and hyphens, starting
 * with a letter, such as `'task-board'`.
 * @param shape The doc's fields. A value at the top (not inside a list or record) needs a
 * default, such as `v.optional(v.boolean(), false)`, because a new doc starts empty.
 * Leaving it out is a type error.
 * @param options `awareness`: the schema of each member's live state in this doc.
 * @throws {LiveThingConfigError} When the name, a field name or a field is not valid, or a
 * value at the top gives no default.
 *
 * @example
 * ```ts
 * import { doc, list, record, richText, text } from '@livething/plugin-collaboration'
 * import * as v from 'valibot'
 *
 * export const taskBoard = doc(
 *   'task-board',
 *   {
 *     title: text(),
 *     archived: v.optional(v.boolean(), false),
 *     tasks: list({ id: v.string(), title: text(), done: v.boolean(), notes: richText() }),
 *     settings: record({ collapsed: v.array(v.string()) }),
 *   },
 *   { awareness: v.object({ viewingTaskId: v.nullable(v.string()) }) },
 * )
 * ```
 */
export function doc<
  const TName extends string,
  const TShape extends Shape,
  TAwareness extends Leaf | undefined = undefined,
>(
  name: TName,
  shape: TShape & TopDefaults<TShape>,
  options?: DocOptions<TAwareness>,
): DocDef<TName, TShape, TAwareness> {
  if (typeof name !== 'string' || !DOC_NAME.test(name)) {
    throw new LiveThingConfigError(
      `doc name '${String(name)}' is not valid. Use 1 to 64 lowercase letters, digits and hyphens, starting with a letter, such as 'task-board'.`,
    );
  }

  const context = `doc('${name}')`;
  if (!isShape(shape) || Object.keys(shape).length === 0) {
    throw new LiveThingConfigError(`${context} has no fields. Give it at least one.`);
  }

  checkShape(shape, { context, path: '', top: true, seen: new Set([shape]) });

  const awareness = options?.awareness;
  if (awareness !== undefined && !isLeaf(awareness)) {
    throw new LiveThingConfigError(
      `${context}: the 'awareness' option must be a Standard Schema, such as v.object({ ... }).`,
    );
  }

  return { name, shape, awareness: awareness as TAwareness };
}

/** A Standard Schema. Some libraries' schemas are functions, such as arktype's. */
function isLeaf(field: unknown): field is Leaf {
  return (
    (typeof field === 'object' || typeof field === 'function') &&
    field !== null &&
    typeof (field as Partial<Leaf>)['~standard']?.validate === 'function'
  );
}

/** What a field is. `doc()` has already checked every field, so anything else is a shape. */
export function kindOf(field: Field): 'text' | 'rich-text' | 'list' | 'record' | 'leaf' | 'shape' {
  if (isLeaf(field)) return 'leaf';

  if (KIND in field) return (field as TextField | RichTextField | ListField | RecordField)[KIND];

  return 'shape';
}

function isShape(field: unknown): field is Shape {
  return (
    typeof field === 'object' &&
    field !== null &&
    !Array.isArray(field) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(field)) &&
    !(KIND in field) &&
    !isLeaf(field)
  );
}

/**
 * Where a check is. `top` is true while the path from the doc's top goes only through
 * plain objects: a value there exists before anyone writes it, so its schema must give
 * a default.
 */
interface Where {
  readonly context: string;
  readonly path: string;
  readonly top: boolean;
  /** The shapes on the path here, to refuse a shape that contains itself. */
  readonly seen: ReadonlySet<object>;
}

function checkShape(shape: Shape, where: Where): void {
  for (const [key, field] of Object.entries(shape)) {
    if (!FIELD_NAME.test(key) || RESERVED_FIELD_NAMES.has(key)) {
      throw new LiveThingConfigError(
        `${where.context}: '${where.path}${key}' is not a valid field name. Use letters, digits, '_' and '$', starting with a letter, '_' or '$'.`,
      );
    }

    checkField(field, { ...where, path: `${where.path}${key}` });
  }
}

function checkField(field: unknown, where: Where): void {
  if (isLeaf(field)) {
    if (where.top) checkDefault(field, where);
    return;
  }

  if (typeof field === 'object' && field !== null && where.seen.has(field)) {
    throw new LiveThingConfigError(`${where.context}: '${where.path}' contains itself.`);
  }

  if (typeof field === 'object' && field !== null && KIND in field) {
    const kind = (field as { [KIND]: unknown })[KIND];
    if (kind === 'text' || kind === 'rich-text') return;

    if (kind === 'list' || kind === 'record') {
      const item = (field as ListField | RecordField).item;
      const path = `${where.path}${kind === 'list' ? '[]' : '{}'}`;
      checkField(item, { ...where, path, top: false, seen: new Set([...where.seen, field]) });
      return;
    }
  }

  if (isShape(field) && Object.keys(field).length > 0) {
    const seen = new Set([...where.seen, field]);
    checkShape(field, { ...where, path: `${where.path}.`, seen });
    return;
  }

  throw new LiveThingConfigError(
    `${where.context}: '${where.path}' is not a field. Use text(), richText(), list(...), record(...), a Standard Schema, or a plain object of fields.`,
  );
}

/**
 * A value at the top must take `undefined` and give its default at once. Other values
 * are not run here: their schemas may rightly throw on `undefined`, and a schema that
 * checks asynchronously is refused when a change is checked.
 */
function checkDefault(schema: Leaf, where: Where): void {
  const { context, path } = where;
  let result: ReturnType<Leaf['~standard']['validate']>;
  try {
    result = schema['~standard'].validate(undefined);
  } catch (error) {
    throw new LiveThingConfigError(
      `${context}: the schema of '${path}' threw when it made the default: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Some libraries, such as zod, turn a throw into a Promise too, so this says both.
  if (result instanceof Promise) {
    result.catch(() => {});
    throw new LiveThingConfigError(
      `${context}: '${path}' did not give its default at once: its schema checks asynchronously, or it throws when given undefined. A change is checked at once, so use a schema that checks synchronously.`,
    );
  }

  if (result.issues) {
    throw new LiveThingConfigError(
      `${context}: '${path}' needs a default, because a new doc starts empty. For example: v.optional(v.boolean(), false).`,
    );
  }
}

// ---- types read from the schema ----

type Simplify<T> = { [K in keyof T]: T[K] } & {};

/**
 * A value changes as a whole, so nothing inside it can be written: you set the whole
 * value again. Arrays and tuples keep their shape, read-only. `D` counts the levels, so a
 * type that contains itself, such as a JSON value type, stops 8 levels down instead of
 * going on forever: below that, it is left as it is.
 */
type DeepReadonly<T, D extends readonly 0[] = []> = unknown extends T
  ? T
  : D['length'] extends 8
    ? T
    : T extends string | number | boolean | bigint | symbol | null | undefined
      ? T // also a branded string or number, which is a primitive with an object part
      : T extends (...args: never[]) => unknown
        ? T
        : T extends Uint8Array
          ? T
          : T extends readonly (infer E)[]
            ? number extends T['length']
              ? readonly DeepReadonly<E, [...D, 0]>[] // any array, branded or not, reads as a plain read-only array
              : { readonly [K in keyof T]: DeepReadonly<T[K], [...D, 0]> } // a tuple keeps its shape
            : T extends ReadonlyMap<infer K, infer V>
              ? ReadonlyMap<DeepReadonly<K, [...D, 0]>, DeepReadonly<V, [...D, 0]>>
              : T extends ReadonlySet<infer V>
                ? ReadonlySet<DeepReadonly<V, [...D, 0]>>
                : { readonly [K in keyof T]: DeepReadonly<T[K], [...D, 0]> };

/**
 * What reads a field: the read-only, plain JSON copy in `state`, `select()`,
 * `versions.read()`, the server's `read()` and `onSave`. Text and rich text read as
 * strings, lists as read-only arrays and records as read-only objects. A new snapshot
 * reuses every part that did not change, so `===` tells you what changed.
 */
export type Snapshot<F> = F extends TextField | RichTextField
  ? string
  : F extends ListField<infer I>
    ? readonly Snapshot<I>[]
    : F extends RecordField<infer I>
      ? { readonly [key: string]: Snapshot<I> }
      : F extends Leaf
        ? DeepReadonly<StandardSchemaV1.InferOutput<F>>
        : F extends Shape
          ? Simplify<{ readonly [K in keyof F]: Snapshot<F[K]> }>
          : never;

/**
 * What writes a whole field: a new list item (`push`, `insert`, `set`), a record value
 * (`set`), or a value. It is the schema's input type, so a field with a default may be left
 * out.
 */
export type Input<F> = F extends TextField | RichTextField
  ? string
  : F extends ListField<infer I>
    ? readonly Input<I>[]
    : F extends RecordField<infer I>
      ? { readonly [key: string]: Input<I> }
      : F extends Leaf
        ? StandardSchemaV1.InferInput<F>
        : F extends Shape
          ? Simplify<{ readonly [K in keyof F]: Input<F[K]> }>
          : never;

/**
 * A list in a draft. Read and write items through it; assigning a new array to a list field
 * is a type error. Every write is checked against the item's schema.
 */
export interface DraftList<I extends Field> extends Iterable<Draft<I>> {
  readonly length: number;
  /** The item at `index` (0 or more), or `undefined`. You can write to it. */
  at(index: number): Draft<I> | undefined;
  /**
   * The first item `predicate` accepts. The predicate gets each item as it was when the
   * `change()` began, so it does not see what this change wrote. Read the draft for that.
   */
  find(predicate: (item: Snapshot<I>) => boolean): Draft<I> | undefined;
  /** The index of the first item `predicate` accepts, with the same rule as `find`. */
  findIndex(predicate: (item: Snapshot<I>) => boolean): number;
  /** Add items at the end. */
  push(...items: Input<I>[]): void;
  /** Add items before `index`. */
  insert(index: number, ...items: Input<I>[]): void;
  /** Replace the content of the item at `index` with `item`. It keeps its place and its ID. */
  set(index: number, item: Input<I>): void;
  /** Delete `count` items (default 1) from `index`. */
  delete(index: number, count?: number): void;
  /**
   * Move the item at `from` so it ends up at `to`. It moves the item itself: nothing is
   * copied, so edits others make to it at the same time stay, and it keeps its ID.
   */
  move(from: number, to: number): void;
}

/** A record in a draft: a map from your own keys to items. */
export interface DraftRecord<I extends Field> {
  readonly size: number;
  /** The item at `key`, or `undefined`. You can write to it. */
  get(key: string): Draft<I> | undefined;
  has(key: string): boolean;
  /** Put `item` at `key`, in place of any item there. */
  set(key: string, item: Input<I>): void;
  delete(key: string): void;
  keys(): IterableIterator<string>;
}

/** Fields you change through their own methods or an editor, not by assigning. */
type ContainerKeys<S extends Shape> = {
  [K in keyof S]: S[K] extends Leaf ? never : S[K] extends TextField ? never : K;
}[keyof S];

/** A plain object in a draft: values and text are assigned, the rest is changed in place. */
export type DraftShape<S extends Shape> = Simplify<
  { -readonly [K in Exclude<keyof S, ContainerKeys<S>>]: Draft<S[K]> } & {
    readonly [K in ContainerKeys<S>]: Draft<S[K]>;
  }
>;

/**
 * What `change()` hands you: an object shaped like the doc that you can write to. Assign
 * text and values; change lists and records through their methods. Everything one
 * `change()` writes is one edit: one undo step, one update on the wire.
 */
export type Draft<F> = F extends TextField | RichTextField
  ? string
  : F extends ListField<infer I>
    ? DraftList<I>
    : F extends RecordField<infer I>
      ? DraftRecord<I>
      : F extends Leaf
        ? DeepReadonly<StandardSchemaV1.InferOutput<F>>
        : F extends Shape
          ? DraftShape<F>
          : never;

/** The end of a path to a Yjs container. */
export interface YRef<T> {
  readonly '~yjs': T;
}

/** The Yjs type behind a text field: what an editor binds to. */
export type YTypeOf<F> = F extends TextField
  ? Y.Text
  : F extends RichTextField
    ? Y.XmlFragment
    : never;

/** The end of a path to one list item or record entry, which an item anchor stays on. */
export interface ItemRef {
  readonly '~item': true;
}

/**
 * The paths a picker such as `yjs.at((p) => p.tasks[0].notes)` follows. Text and rich
 * text end at their Yjs type, list items and record entries are {@link ItemRef}s, and
 * a plain value has no Yjs type.
 */
export type PathOf<F> = F extends TextField | RichTextField
  ? YRef<YTypeOf<F>>
  : F extends ListField<infer I>
    ? { readonly [index: number]: PathOf<I> & ItemRef }
    : F extends RecordField<infer I>
      ? { readonly [key: string]: PathOf<I> & ItemRef }
      : F extends Leaf
        ? { readonly '~a plain value has no Yjs type': true }
        : F extends Shape
          ? { readonly [K in keyof F]: PathOf<F[K]> }
          : never;

/**
 * The doc types a `collaboration()` option lists, by name.
 *
 * @throws {LiveThingConfigError} When a doc type is listed twice, or there is none.
 */
export function docTypesByName(docs: readonly DocDef[]): Map<string, DocDef> {
  const defs = new Map<string, DocDef>();
  for (const def of docs) {
    if (defs.has(def.name)) {
      throw new LiveThingConfigError(`collaboration: the doc type '${def.name}' is listed twice`);
    }

    defs.set(def.name, def);
  }

  if (defs.size === 0) {
    throw new LiveThingConfigError('collaboration: list at least one doc type in `docs`');
  }

  return defs;
}

/** The doc types of an app, by name. */
export type DocsByName<TDocs extends readonly DocDef[]> = {
  [D in TDocs[number] as D['name']]: D;
};

/** The doc type named `N` in `TDocs`. Works for a generic `N`, where `DocsByName` can't. */
export type DocNamed<TDocs extends readonly DocDef[], N extends string> = Extract<
  TDocs[number],
  { name: N }
>;

/**
 * Marks a value at the top of a doc whose schema gives no default. The property name
 * is the message, because TypeScript prints the name of a missing property.
 */
interface NeedsDefault {
  readonly 'a value at the top of a doc needs a default, such as v.optional(v.boolean(), false)': true;
}

/** Keeps each field as it is, except a value at the top with no default, which gets {@link NeedsDefault}. */
type TopDefaults<S> = {
  [K in keyof S]: S[K] extends TextField | RichTextField | ListField<any> | RecordField<any>
    ? S[K]
    : S[K] extends Leaf
      ? undefined extends StandardSchemaV1.InferInput<S[K]>
        ? S[K]
        : NeedsDefault
      : S[K] extends Shape
        ? TopDefaults<S[K]>
        : S[K];
};
